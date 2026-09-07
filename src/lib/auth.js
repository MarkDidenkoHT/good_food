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
