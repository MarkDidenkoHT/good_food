import jwt from 'jsonwebtoken';
import { db } from './db.js';

const SECRET = process.env.JWT_SECRET || 'dev-insecure-secret';
export const ADMIN_COOKIE = 'gf_admin';
export const USER_COOKIE = 'gf_user';

export function sign(payload, expiresIn = '12h') {
  return jwt.sign(payload, SECRET, { expiresIn });
}

export function verify(token) {
  try { return jwt.verify(token, SECRET); } catch { return null; }
}

export function cookieOpts(maxAgeMs) {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: maxAgeMs,
    path: '/'
  };
}

/* The mini-app session. Thirty days, and it carries `cv` — the generation of
   the company code it was issued against — so that reissuing the code can
   invalidate every session of that company at once. See lib/companyCode.js. */
export function issueUserSession(res, user) {
  res.cookie(
    USER_COOKIE,
    sign({
      role: 'user',
      id: user.id,
      name: user.user_name,
      company_id: user.company_id,
      company_role: user.role,
      cv: user.code_version ?? 1
    }, '30d'),
    cookieOpts(30 * 24 * 3600 * 1000)
  );
}

/* A token proves who signed in, not that they still may. Blocking, deleting,
   demoting or moving someone has to take effect on their next request, not
   when a 12-hour or 30-day cookie runs out — so every request reads the row. */
function loadAccount(id) {
  return db
    .from('users')
    .select('id, user_name, role, access, company_id, companies(access)')
    .eq('id', id)
    .maybeSingle();
}

export async function requireAdmin(req, res, next) {
  const claims = verify(req.cookies?.[ADMIN_COOKIE]);
  if (!claims || claims.role !== 'admin') return res.status(401).json({ error: 'Not authenticated' });

  const { data: user, error } = await loadAccount(claims.id);
  if (error) return res.status(503).json({ error: 'Database unavailable' });
  if (!user || user.role !== 'admin' || user.access === false || user.companies?.access === false) {
    res.clearCookie(ADMIN_COOKIE, { path: '/' });
    return res.status(401).json({ error: 'Not authenticated' });
  }

  req.admin = { ...claims, name: user.user_name };
  next();
}

export async function requireUser(req, res, next) {
  const claims = verify(req.cookies?.[USER_COOKIE]);
  if (!claims || claims.role !== 'user') return res.status(401).json({ error: 'Not authenticated' });

  const { data: user, error } = await loadAccount(claims.id);
  if (error) return res.status(503).json({ error: 'Database unavailable' });
  if (!user || user.access === false || !user.company_id ||
      user.company_id !== claims.company_id || user.companies?.access === false) {
    res.clearCookie(USER_COOKIE, { path: '/' });
    return res.status(401).json({ error: 'Not authenticated' });
  }

  // the role comes from the row, never the token: a demoted owner is demoted now
  req.user = { ...claims, name: user.user_name, company_role: user.role };
  next();
}
