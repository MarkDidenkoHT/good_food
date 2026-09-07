import { Router } from 'express';
import { supabase, dbError } from '../lib/supabase.js';
import { verifyInitData } from '../lib/telegram.js';
import { sign, cookieOpts, ADMIN_COOKIE, USER_COOKIE, requireAdmin, requireUser } from '../lib/auth.js';

export const authRouter = Router();

/* Two different credentials:

   - admins log into the panel with their own chat_id + personal user_code;
   - company users open the mini-app inside Telegram, which proves who they
     are cryptographically, and join a company once with the COMPANY code.

   A code never crosses between the two. */

const CODE_RE = /^[A-Za-z0-9_-]{1,32}$/;

/* ---------- admin panel ---------- */

authRouter.post('/admin/login', async (req, res) => {
  const code = String(req.body?.code || '').trim();
  const chatId = String(req.body?.chat_id || '').trim();
  if (!code || !chatId) return res.status(400).json({ error: 'Chat ID and code required' });
  if (!CODE_RE.test(code) || !/^-?\d{1,20}$/.test(chatId)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const { data, error } = await supabase
    .from('users')
    .select('id, user_name, user_code, access, role, chat_id')
    .ilike('user_code', code)
    .maybeSingle();
  if (error) return dbError(res, error, 500);

  // Two factors, one message: never reveal which half was wrong.
  const ok = data && data.role === 'admin' && String(data.chat_id ?? '') === chatId;
  if (!ok) return res.status(401).json({ error: 'Invalid credentials' });
  if (data.access === false) return res.status(403).json({ error: 'Access disabled' });

  await supabase.from('users').update({ last_login: new Date().toISOString() }).eq('id', data.id);

  res.cookie(
    ADMIN_COOKIE,
    sign({ role: 'admin', id: data.id, name: data.user_name }, '12h'),
    cookieOpts(12 * 3600 * 1000)
  );
  res.json({ ok: true, id: data.id, user_name: data.user_name });
});

authRouter.post('/admin/logout', (req, res) => {
  res.clearCookie(ADMIN_COOKIE, { path: '/' });
  res.json({ ok: true });
});

authRouter.get('/admin/me', requireAdmin, (req, res) => {
  res.json({ id: req.admin.id, user_name: req.admin.name });
});

/* ---------- mini-app ---------- */

/* Resolve the caller from a signed Telegram launch payload. Outside
   production an unsigned chat_id is accepted so the app can be driven from a
   desktop browser; that shortcut must never reach a live deploy. */
function identify(body) {
  const tgUser = verifyInitData(body?.initData);
  if (tgUser) return { chatId: tgUser.id, tgUser };

  if (process.env.NODE_ENV !== 'production' && body?.dev_chat_id) {
    console.warn('[auth] dev chat_id accepted — never enable this in production');
    return { chatId: Number(body.dev_chat_id), tgUser: null };
  }
  return null;
}

async function loadUser(chatId) {
  return supabase
    .from('users')
    .select('id, user_name, access, role, chat_id, company_id, companies(id, company_name, access)')
    .eq('chat_id', chatId)
    .maybeSingle();
}

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

function publicUser(user) {
  return {
    id: user.id,
    user_name: user.user_name,
    role: user.role,
    company_id: user.company_id,
    company_name: user.companies?.company_name || null
  };
}

/* Telegram-native sign-in. Reports precisely why access is not granted so the
   mini-app can show the right screen: waiting for approval vs join a company. */
authRouter.post('/user/telegram', async (req, res) => {
  const who = identify(req.body);
  if (!who) return res.status(401).json({ error: 'Не удалось подтвердить Telegram' });

  const { data: user, error } = await loadUser(who.chatId);
  if (error) return dbError(res, error, 500);
  if (!user) return res.status(404).json({ error: 'not_registered' });
  if (user.access === false) return res.status(403).json({ error: 'pending' });
  if (!user.company_id) return res.status(409).json({ error: 'no_company' });
  if (user.companies?.access === false) return res.status(403).json({ error: 'company_blocked' });

  await supabase.from('users').update({ last_login: new Date().toISOString() }).eq('id', user.id);
  issueSession(res, user);
  res.json(publicUser(user));
});

/* Join a company with its code. The user must already be approved by an
   admin, so a leaked company code alone gets nobody in. */
authRouter.post('/user/join', async (req, res) => {
  const who = identify(req.body);
  if (!who) return res.status(401).json({ error: 'Не удалось подтвердить Telegram' });

  const code = String(req.body?.code || '').trim();
  if (!code) return res.status(400).json({ error: 'Введите код компании' });
  if (!CODE_RE.test(code)) return res.status(401).json({ error: 'Неверный код' });

  const { data: user, error } = await loadUser(who.chatId);
  if (error) return dbError(res, error, 500);
  if (!user) return res.status(404).json({ error: 'not_registered' });
  if (user.access === false) return res.status(403).json({ error: 'pending' });

  const { data: company, error: cErr } = await supabase
    .from('companies').select('id, company_name, access').ilike('company_code', code).maybeSingle();
  if (cErr) return dbError(res, cErr, 500);
  if (!company) return res.status(401).json({ error: 'Неверный код' });
  if (company.access === false) return res.status(403).json({ error: 'company_blocked' });

  // First person into a company becomes its owner; everyone after is staff.
  const { count } = await supabase
    .from('users').select('id', { count: 'exact', head: true }).eq('company_id', company.id);
  const role = count ? 'employee' : 'owner';

  const { data: updated, error: uErr } = await supabase
    .from('users')
    .update({ company_id: company.id, role, last_login: new Date().toISOString() })
    .eq('id', user.id)
    .select('id, user_name, role, company_id')
    .single();
  if (uErr) return dbError(res, uErr);

  issueSession(res, updated);
  res.json({ ...publicUser(updated), company_name: company.company_name });
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
