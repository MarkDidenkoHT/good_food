import { Router } from 'express';
import { supabase, dbError } from '../lib/supabase.js';
import { verifyInitData } from '../lib/telegram.js';
import { sign, cookieOpts, ADMIN_COOKIE, USER_COOKIE, requireAdmin, requireUser,
         issueUserSession as issueSession } from '../lib/auth.js';
import { sendNewUserNotice } from '../lib/notices.js';

export const authRouter = Router();

/* One credential in the whole system: chat_id + the COMPANY code.

   Inside Telegram the mini-app proves identity cryptographically. In a plain
   browser — and for the admin panel, which is not a mini-app — the chat id is
   typed instead. That is weaker: a chat id is not really a secret, so the
   company code carries the security.

   Registration is code-first. Pressing /start creates nothing anybody has to
   act on; entering the company code is what attaches the person to a company
   and puts the request in front of the operators. Approval comes after, so a
   leaked code still gets nobody in on its own.

   And the code no longer stops mattering once it has been typed. Every user
   carries the generation of the code they entered (see lib/companyCode.js);
   reissuing it makes the whole company stale in a single write, and each of
   them returns only by typing the new one. */

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
    .select('id, user_name, access, role, chat_id, tg_username, company_id, code_version, ' +
            'companies(id, company_name, access, code_version)')
    .eq('chat_id', chatId)
    .maybeSingle();
}

function loadCompany(code) {
  return supabase
    .from('companies')
    .select('id, company_name, access, code_version')
    .ilike('company_code', code)
    .maybeSingle();
}

/* The company has moved on to a newer code than this user last typed. They
   keep their place on the roster and their history; they simply cannot order
   until somebody gives them the current code. */
const staleCode = (user) =>
  (user.code_version ?? 0) < (user.companies?.code_version ?? 1);

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

/* Silent sign-in for a user already attached to a company. Reports precisely
   why it failed so the app can show the right screen. */
authRouter.post('/user/telegram', async (req, res) => {
  const chatId = identify(req.body);
  if (chatId === null) return res.status(401).json({ error: 'need_code' });

  const { data: user, error } = await loadUser(chatId);
  if (error) return dbError(res, error, 500);
  if (!user) return res.status(404).json({ error: 'not_registered' });
  /* Ahead of the approval check on purpose: under the new registration a
     person who has not yet entered a code is not waiting on anybody, they
     are waiting on themselves, and must be told to type the code. */
  if (!user.company_id) return res.status(409).json({ error: 'no_company' });
  if (user.access === false) return res.status(403).json({ error: 'pending' });
  if (user.companies?.access === false) return res.status(403).json({ error: 'company_blocked' });
  if (staleCode(user)) return res.status(409).json({ error: 'code_rotated' });

  await touch(user.id);
  issueSession(res, user);
  res.json(publicUser(user));
});

/* The company code: joining on first use, and coming back after a rotation.

   The user must already exist — /start is what creates them — but they need
   not be approved yet, because entering the code is a step of registering
   rather than a reward for having registered. An unapproved user who gets
   the code right is attached to the company and announced to the operators;
   they still leave here without a session. */
authRouter.post('/user/join', async (req, res) => {
  const chatId = identify(req.body);
  if (chatId === null) return res.status(401).json({ error: 'Введите корректный Chat ID' });

  const code = String(req.body?.code || '').trim();
  if (!code) return res.status(400).json({ error: 'Введите код компании' });
  if (!CODE_RE.test(code)) return res.status(401).json({ error: 'Неверный код' });

  const { data: user, error } = await loadUser(chatId);
  if (error) return dbError(res, error, 500);
  if (!user) return res.status(404).json({ error: 'not_registered' });

  const { data: company, error: cErr } = await loadCompany(code);
  if (cErr) return dbError(res, cErr, 500);
  if (!company) return res.status(401).json({ error: 'Неверный код' });
  if (company.access === false) return res.status(403).json({ error: 'company_blocked' });

  // Already elsewhere: the code has to be their own company's.
  if (user.company_id && user.company_id !== company.id) {
    return res.status(403).json({ error: 'Этот код принадлежит другой компании' });
  }

  /* Nobody is promoted by being early. Whoever registers first would
     otherwise own the company — and, where owners may reissue the code, hold
     its kill switch — on no better evidence than having typed fastest. An
     admin names the owner in the panel. */
  const firstJoin = !user.company_id;
  const role = firstJoin ? 'employee' : user.role;

  const { data: updated, error: uErr } = await supabase
    .from('users')
    .update({
      company_id: company.id,
      role,
      // whichever generation of the code they just typed, it is the current one
      code_version: company.code_version ?? 1,
      last_login: new Date().toISOString()
    })
    .eq('id', user.id)
    .select('id, user_name, role, company_id, code_version')
    .single();
  if (uErr) return dbError(res, uErr);

  /* The operators hear about a person once: when they first name a company.
     Coming back after a rotation is not a new request — they are already on
     the roster and already approved. */
  if (firstJoin) {
    await sendNewUserNotice(
      { ...updated, chat_id: user.chat_id, tg_username: user.tg_username, access: user.access },
      company.company_name
    );
  }

  // Attached, announced, and still waiting on an operator.
  if (user.access === false) return res.status(403).json({ error: 'pending' });

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
    .select('id, user_name, access, role, company_id, code_version, ' +
            'companies(company_name, access, code_version)')
    .eq('id', req.user.id)
    .maybeSingle();
  if (error) return dbError(res, error, 500);
  /* A stale code fails the same way as the rest: the app drops back to
     /user/telegram, which is the one place that says precisely what went
     wrong and gets the right screen drawn. */
  if (!data || data.access === false || !data.company_id || staleCode(data)) {
    res.clearCookie(USER_COOKIE, { path: '/' });
    return res.status(401).json({ error: 'Not authenticated' });
  }
  res.json(publicUser(data));
});
