import jwt from 'jsonwebtoken';

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

export function requireAdmin(req, res, next) {
  const claims = verify(req.cookies?.[ADMIN_COOKIE]);
  if (!claims || claims.role !== 'admin') return res.status(401).json({ error: 'Not authenticated' });
  req.admin = claims;
  next();
}

export function requireUser(req, res, next) {
  const claims = verify(req.cookies?.[USER_COOKIE]);
  if (!claims || claims.role !== 'user') return res.status(401).json({ error: 'Not authenticated' });
  req.user = claims;
  next();
}
