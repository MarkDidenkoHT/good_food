import { supabase } from './supabase.js';
import { USER_COOKIE } from './auth.js';
import { announceCodeRotated } from './notices.js';

/* The company code as a living credential.

   A code used to be a one-time door: typed once, it wrote users.company_id
   and was never consulted again. Now every company carries a version and
   every user carries the version they last typed. Reissuing the code bumps
   the company's version, which makes every user stale in one write — the
   fastest way to shut a company down — and each of them comes back only by
   typing the new code, which is the owner's to hand out.

   Stale is not blocked: the roster, the history and the approval all stand.
   Only ordering stops. For the blunt version — everybody out, nobody back —
   companies.access is still the switch. */

const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function randomCode(len = 6) {
  let s = '';
  for (let i = 0; i < len; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
  return s;
}

/* Every mini-app request checks the version, so it cannot be a query every
   time. Companies are few and change rarely; a short TTL keeps a second
   instance no more than that far behind, and the rotation itself refreshes
   the entry in the process that served it. */
const TTL_MS = 30_000;
const cache = new Map();               // company id -> { version, at }

export const forgetCompany = (id) => cache.delete(Number(id));

export async function currentVersion(companyId) {
  const id = Number(companyId);
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.version;

  const { data, error } = await supabase
    .from('companies').select('code_version').eq('id', id).maybeSingle();
  if (error) {
    console.error('[code] version lookup failed:', error);
    return null;                       // unknown — the caller decides, see below
  }

  const version = data?.code_version ?? 1;
  cache.set(id, { version, at: Date.now() });
  return version;
}

/* True when this user has typed the code the company is currently on. */
export async function codeIsCurrent(user) {
  if (!user?.company_id) return false;
  const version = await currentVersion(user.company_id);
  // A database we cannot reach must not lock every company out of the app;
  // every other endpoint is about to fail on its own anyway.
  if (version === null) return true;
  return (user.code_version ?? 0) >= version;
}

/* Guards the mini-app API. A rotation has to reach people who are already
   signed in — that is the entire point of pressing the button — and the
   session cookie is a stateless JWT that would otherwise stand for a month.
   A session issued before this existed carries no cv and so counts as stale:
   those users are signed back in silently from initData, without typing. */
export async function requireFreshCode(req, res, next) {
  const { company_id, cv } = req.user || {};
  if (!company_id) return res.status(401).json({ error: 'Not authenticated' });

  const version = await currentVersion(company_id);
  if (version === null || (cv ?? 0) >= version) return next();

  res.clearCookie(USER_COOKIE, { path: '/' });
  res.status(409).json({ error: 'code_rotated' });
}

/* Reissues the code and shuts the company out in one write.

   `keepUserId` is the owner who pressed the button themselves: they already
   have the new code, so re-stamping them spares them typing back in to the
   app they are standing in. */
export async function rotateCompanyCode(companyId, { actorName, keepUserId = null } = {}) {
  const id = Number(companyId);

  const { data: company, error } = await supabase
    .from('companies').select('id, company_name, code_version').eq('id', id).maybeSingle();
  if (error) return { error };
  if (!company) return { notFound: true };

  const version = (company.code_version || 1) + 1;

  /* Six characters collide about never, but company_code is unique and a
     rotation refused over a coin flip would be a baffling thing to explain
     to someone trying to lock their company down. */
  let saved = null;
  let code = null;
  for (let attempt = 0; attempt < 5 && !saved; attempt++) {
    const candidate = randomCode(6);
    const { data, error: uErr } = await supabase
      .from('companies')
      .update({
        company_code: candidate,
        code_version: version,
        code_rotated_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq('id', id)
      .select('id, company_name, company_code, code_version')
      .single();

    if (uErr) {
      if (uErr.code === '23505') continue;       // that code is taken, draw again
      return { error: uErr };
    }
    saved = data;
    code = candidate;
  }
  if (!saved) return { error: new Error('could not allocate a free company code') };

  cache.set(id, { version, at: Date.now() });

  if (keepUserId) {
    await supabase.from('users').update({ code_version: version }).eq('id', keepUserId);
  }

  // Who to tell. A blocked account is not a silent failure to explain later,
  // it is simply not a recipient.
  const { data: staff } = await supabase
    .from('users')
    .select('id, user_name, chat_id, role')
    .eq('company_id', id)
    .not('chat_id', 'is', null)
    .neq('access', false);

  const everyone = staff || [];
  const keeper = keepUserId ? everyone.find((u) => u.id === keepUserId) || null : null;
  const suspended = everyone.filter((u) => u.id !== keepUserId);

  await announceCodeRotated({ company: saved, code, actorName, suspended, keeper });

  return { company: saved, code, affected: suspended.length };
}
