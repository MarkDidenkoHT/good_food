import { Router } from 'express';
import { supabase, dbError } from '../lib/supabase.js';
import { sign, cookieOpts, ADMIN_COOKIE, USER_COOKIE, requireAdmin, requireUser } from '../lib/auth.js';

export const authRouter = Router();

/* ---------- admin ---------- */

authRouter.post('/admin/login', (req, res) => {
  const { username, password } = req.body || {};
  const okUser = username === (process.env.ADMIN_USERNAME || 'admin');
  const okPass = password && password === process.env.ADMIN_PASSWORD;
  if (!okUser || !okPass) return res.status(401).json({ error: 'Invalid credentials' });

  res.cookie(ADMIN_COOKIE, sign({ role: 'admin', username }), cookieOpts(12 * 3600 * 1000));
  res.json({ ok: true, username });
});

authRouter.post('/admin/logout', (req, res) => {
  res.clearCookie(ADMIN_COOKIE, { path: '/' });
  res.json({ ok: true });
});

authRouter.get('/admin/me', requireAdmin, (req, res) => {
  res.json({ username: req.admin.username });
});

/* ---------- company users (mini-app) ---------- */

authRouter.post('/user/login', async (req, res) => {
  const code = String(req.body?.code || '').trim();
  if (!code) return res.status(400).json({ error: 'Code required' });

  const { data, error } = await supabase
    .from('users')
    .select('id, user_name, user_code, access, role')
    .eq('user_code', code)
    .maybeSingle();

  if (error) return dbError(res, error, 500);
  if (!data) return res.status(401).json({ error: 'Unknown code' });
  if (data.access === false) return res.status(403).json({ error: 'Access disabled' });
  if (data.role === 'admin') return res.status(403).json({ error: 'Admins use the admin panel' });

  await supabase.from('users').update({ last_login: new Date().toISOString() }).eq('id', data.id);

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
