import { Router } from 'express';
import { supabase, dbError } from '../lib/supabase.js';
import { sign, cookieOpts, ADMIN_COOKIE, USER_COOKIE, requireAdmin, requireUser } from '../lib/auth.js';

export const authRouter = Router();

/* One credential for everyone: the code from public.users. The row's role
   decides which surface you get — 'admin' → admin panel, 'owner' → mini-app.
   Neither login accepts the other's role, so a leaked owner code can never
   reach the panel. */

/* Codes are matched case-insensitively: they get read off paper and typed on
   phones, and rows inserted by hand won't follow the panel's casing.
   ilike treats % and _ as wildcards, so codes are restricted up front to
   characters that mean nothing to it rather than escaped after the fact. */
const CODE_RE = /^[A-Za-z0-9_-]{1,32}$/;

async function findByCode(code) {
  return supabase
    .from('users')
    .select('id, user_name, user_code, access, role')
    .ilike('user_code', code)
    .maybeSingle();
}

function stampLogin(id) {
  return supabase.from('users').update({ last_login: new Date().toISOString() }).eq('id', id);
}

/* ---------- admin panel ---------- */

authRouter.post('/admin/login', async (req, res) => {
  const code = String(req.body?.code || '').trim();
  if (!code) return res.status(400).json({ error: 'Code required' });
  if (!CODE_RE.test(code)) return res.status(401).json({ error: 'Invalid code' });

  const { data, error } = await findByCode(code);
  if (error) return dbError(res, error, 500);

  // Same 401 for "no such code" and "not an admin" — don't confirm to a
  // holder of an owner code that their code is valid somewhere.
  if (!data || data.role !== 'admin') return res.status(401).json({ error: 'Invalid code' });
  if (data.access === false) return res.status(403).json({ error: 'Access disabled' });

  await stampLogin(data.id);

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

/* ---------- company users (mini-app) ---------- */

authRouter.post('/user/login', async (req, res) => {
  const code = String(req.body?.code || '').trim();
  if (!code) return res.status(400).json({ error: 'Code required' });
  if (!CODE_RE.test(code)) return res.status(401).json({ error: 'Unknown code' });

  const { data, error } = await findByCode(code);
  if (error) return dbError(res, error, 500);

  if (!data || data.role === 'admin') return res.status(401).json({ error: 'Unknown code' });
  if (data.access === false) return res.status(403).json({ error: 'Access disabled' });

  await stampLogin(data.id);

  res.cookie(
    USER_COOKIE,
    sign({ role: 'user', id: data.id, name: data.user_name }, '30d'),
    cookieOpts(30 * 24 * 3600 * 1000)
  );
  res.json({ ok: true, id: data.id, user_name: data.user_name });
});

authRouter.post('/user/logout', (req, res) => {
  res.clearCookie(USER_COOKIE, { path: '/' });
  res.json({ ok: true });
});

authRouter.get('/user/me', requireUser, (req, res) => {
  res.json({ id: req.user.id, user_name: req.user.name });
});
