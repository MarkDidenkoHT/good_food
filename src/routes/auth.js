import { Router } from 'express';
import { supabase, dbError } from '../lib/supabase.js';
import { verifyInitData } from '../lib/telegram.js';
import { sign, cookieOpts, ADMIN_COOKIE, USER_COOKIE, requireAdmin, requireUser } from '../lib/auth.js';

export const authRouter = Router();

/* One credential in the whole system: chat_id + the COMPANY code.

   Inside Telegram the mini-app proves identity cryptographically and no code
   is needed at all. In a plain browser — and for the admin panel, which is
   not a mini-app — the chat id is typed instead. That is weaker: a chat id is
   not really a secret, so the company code carries the security. Rotate a
   company code the moment it leaks. */

const CODE_RE = /^[A-Za-z0-9_-]{1,32}$/;
const CHAT_RE = /^-?\d{1,20}$/;

/* Signed Telegram payload first; a typed chat id is the fallback. */
function identify(body) {
  const tgUser = verifyInitData(body?.initData);
  if (tgUser) return Number(tgUser.id);

  const typed = String(body?.chat_id ?? '').trim();
  return CHAT_RE.test(typed) ? Number(typed) : null;
}

function loadUser(chatId) {
  return supabase
    .from('users')
    .select('id, user_name, access, role, chat_id, company_id, companies(id, company_name, access)')
    .eq('chat_id', chatId)
    .maybeSingle();
}

function loadCompany(code) {
  return supabase
    .from('companies')
    .select('id, company_name, access')
    .ilike('company_code', code)
    .maybeSingle();
}

function publicUser(user, companyName) {
  return {
    id: user.id,
    user_name: user.user_name,
    role: user.role,
    company_id: user.company_id,
    company_name: companyName ?? user.companies?.company_name ?? null
  };
}

const touch = (id) =>
  supabase.from('users').update({ last_login: new Date().toISOString() }).eq('id', id);

/* ---------- admin panel ---------- */

/* An admin is a user whose company code they know and whose row says 'admin'.
   Every rejection returns the same message: never confirm which half matched. */
authRouter.post('/admin/login', async (req, res) => {
  const code = String(req.body?.code || '').trim();
  const chatId = String(req.body?.chat_id || '').trim();
  if (!code || !chatId) return res.status(400).json({ error: 'Chat ID and code required' });
  if (!CODE_RE.test(code) || !CHAT_RE.test(chatId)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const [{ data: user, error }, { data: company, error: cErr }] =
    await Promise.all([loadUser(Number(chatId)), loadCompany(code)]);
  if (error) return dbError(res, error, 500);
  if (cErr) return dbError(res, cErr, 500);

  const ok = user && company &&
    user.role === 'admin' &&
    user.company_id === company.id &&
    user.access !== false &&
    company.access !== false;
  if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

  await touch(user.id);
  res.cookie(
    ADMIN_COOKIE,
    sign({ role: 'admin', id: user.id, name: user.user_name }, '12h'),
    cookieOpts(12 * 3600 * 1000)
  );
  res.json({ ok: true, id: user.id, user_name: user.user_name });
});

authRouter.post('/admin/logout', (req, res) => {
  res.clearCookie(ADMIN_COOKIE, { path: '/' });
  res.json({ ok: true });
});

authRouter.get('/admin/me', requireAdmin, (req, res) => {
  res.json({ id: req.admin.id, user_name: req.admin.name });
});

/* ---------- mini-app ---------- */

function issueSession(res, user) {
  res.cookie(
    USER_COOKIE,
    sign({
      role: 'user',
      id: user.id,
      name: user.user_name,
      company_id: user.company_id,
      company_role: user.role
    }, '30d'),
    cookieOpts(30 * 24 * 3600 * 1000)
  );
}

/* Silent sign-in for a user already attached to a company. Reports precisely
   why it failed so the app can show the right screen. */
authRouter.post('/user/telegram', async (req, res) => {
  const chatId = identify(req.body);
  if (chatId === null) return res.status(401).json({ error: 'need_code' });

  const { data: user, error } = await loadUser(chatId);
  if (error) return dbError(res, error, 500);
  if (!user) return res.status(404).json({ error: 'not_registered' });
  if (user.access === false) return res.status(403).json({ error: 'pending' });
  if (!user.company_id) return res.status(409).json({ error: 'no_company' });
  if (user.companies?.access === false) return res.status(403).json({ error: 'company_blocked' });

  await touch(user.id);
  issueSession(res, user);
  res.json(publicUser(user));
});

/* Sign in with the company code, joining the company on first use. The user
   must already exist (via /start) and be approved, so a leaked company code
   on its own gets nobody in. */
authRouter.post('/user/join', async (req, res) => {
  const chatId = identify(req.body);
  if (chatId === null) return res.status(401).json({ error: 'Введите корректный Chat ID' });

  const code = String(req.body?.code || '').trim();
  if (!code) return res.status(400).json({ error: 'Введите код компании' });
  if (!CODE_RE.test(code)) return res.status(401).json({ error: 'Неверный код' });

  const { data: user, error } = await loadUser(chatId);
  if (error) return dbError(res, error, 500);
  if (!user) return res.status(404).json({ error: 'not_registered' });
  if (user.access === false) return res.status(403).json({ error: 'pending' });

  const { data: company, error: cErr } = await loadCompany(code);
  if (cErr) return dbError(res, cErr, 500);
  if (!company) return res.status(401).json({ error: 'Неверный код' });
  if (company.access === false) return res.status(403).json({ error: 'company_blocked' });

  // Already elsewhere: the code has to be their own company's.
  if (user.company_id && user.company_id !== company.id) {
    return res.status(403).json({ error: 'Этот код принадлежит другой компании' });
  }

  let role = user.role;
  if (!user.company_id) {
    // first person into a company owns it; everyone after is staff
    const { count } = await supabase
      .from('users').select('id', { count: 'exact', head: true }).eq('company_id', company.id);
    role = count ? 'employee' : 'owner';
  }

  const { data: updated, error: uErr } = await supabase
    .from('users')
    .update({ company_id: company.id, role, last_login: new Date().toISOString() })
    .eq('id', user.id)
    .select('id, user_name, role, company_id')
    .single();
  if (uErr) return dbError(res, uErr);

  issueSession(res, updated);
  res.json(publicUser(updated, company.company_name));
});

authRouter.post('/user/logout', (req, res) => {
  res.clearCookie(USER_COOKIE, { path: '/' });
  res.json({ ok: true });
});

authRouter.get('/user/me', requireUser, async (req, res) => {
  const { data, error } = await supabase
    .from('users')
    .select('id, user_name, access, role, company_id, companies(company_name, access)')
    .eq('id', req.user.id)
    .maybeSingle();
  if (error) return dbError(res, error, 500);
  if (!data || data.access === false || !data.company_id) {
    res.clearCookie(USER_COOKIE, { path: '/' });
    return res.status(401).json({ error: 'Not authenticated' });
  }
  res.json(publicUser(data));
});
