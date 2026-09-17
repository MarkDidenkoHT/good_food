import jwt from 'jsonwebtoken';
import { db, pool } from './db.js';

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
      cv: user.code_version ?? 1,
      sv: user.user_session_version ?? 1
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
    .select('id, user_name, role, access, company_id, admin_session_version, ' +
            'user_session_version, companies(access)')
    .eq('id', id)
    .maybeSingle();
}

export async function requireAdmin(req, res, next) {
  const claims = verify(req.cookies?.[ADMIN_COOKIE]);
  if (!claims || claims.role !== 'admin') return res.status(401).json({ error: 'Not authenticated' });

  const { data: user, error } = await loadAccount(claims.id);
  if (error) return res.status(503).json({ error: 'Database unavailable' });
  if (!user || user.role !== 'admin' || user.access === false || user.companies?.access === false ||
      claims.sv !== user.admin_session_version) {
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
      user.company_id !== claims.company_id || user.companies?.access === false ||
      claims.sv !== user.user_session_version) {
    res.clearCookie(USER_COOKIE, { path: '/' });
    return res.status(401).json({ error: 'Not authenticated' });
  }

  // the role comes from the row, never the token: a demoted owner is demoted now
  req.user = { ...claims, name: user.user_name, company_role: user.role };
  next();
}

/* Logging out ends every session of that kind for the person, not just the
   cookie in this browser: the version moves on and older tokens stop
   matching. Only a token that is still valid can do it, and only once — a
   stale one bumps nothing. */
export async function revokeSessions(token, kind) {
  const claims = verify(token);
  const column = kind === 'admin' ? 'admin_session_version' : 'user_session_version';
  if (!claims || claims.role !== kind || !Number.isInteger(claims.sv)) return;
  await pool.query(
    `update users set ${column} = ${column} + 1 where id = $1 and ${column} = $2`,
    [claims.id, claims.sv]);
}
