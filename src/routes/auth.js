import { Router } from 'express';
import { db, dbError } from '../lib/db.js';
import { verifyInitData } from '../lib/telegram.js';
import { sign, cookieOpts, ADMIN_COOKIE, USER_COOKIE, requireAdmin, requireUser,
         issueUserSession as issueSession, revokeSessions } from '../lib/auth.js';
import { sendNewUserNotice } from '../lib/notices.js';
import { CODE_RE, hashCode } from '../lib/companyCode.js';
import { membership, membershipState, switchableCompanies, joinCompany, activate, isMember }
  from '../lib/membership.js';
import { authSettings } from '../lib/authSettings.js';

export const authRouter = Router();

/* Who may sign in, and on what evidence.

   A chat id is not a secret. The bot prints one on /id in any chat it is in,
   every new-user notice carries one into the operators' group, and the admin
   panel has them on screen in a table. So a chat id can say who someone
   claims to be; it can never be what proves it.

   The mini-app therefore accepts exactly one credential: the launch payload
   Telegram signs with a key derived from the bot token. verifyInitData checks
   that signature and its age, and identify() returns a chat id only when it
   passes. There is no typed-chat-id path here any more — a browser outside
   Telegram has nothing to present and is told to open the app from the bot.

   The admin panel is not a mini-app and has no initData, so it keeps a typed
   login — but it is chat id AND the company code, checked together, and
   /admin/login below is the only place that reads a chat id off the body.

   Registration is code-first. Pressing /start creates nothing anybody has to
   act on; entering the company code is what attaches the person to a company
   and puts the request in front of the operators. Approval comes after, so a
   leaked code still gets nobody in on its own.

   And the code no longer stops mattering once it has been typed. Every
   membership carries the generation of the code entered for it (see
   lib/companyCode.js); reissuing it makes the whole company stale in a single
   write, and each of them returns only by typing the new one.

   A person may belong to several companies. The roster is user_companies; a
   session names one of them, and signing in means choosing one — the last one
   used, or the first that can be used. */

const CHAT_RE = /^-?\d{1,20}$/;

/* Password guessing. The company code is the secret in both logins, so wrong
   attempts are counted: ten within fifteen minutes and that key is refused
   until the window has passed. The admin panel is keyed by client address
   (X-Forwarded-For from the proxy), the mini-app by the signed chat id. Kept
   in memory: there is one server, and a restart forgiving everyone is fine. */
const FAIL_LIMIT = 10;
const FAIL_WINDOW_MS = 15 * 60 * 1000;
const failures = new Map();

function throttled(key) {
  const f = failures.get(key);
  if (f && Date.now() - f.since > FAIL_WINDOW_MS) failures.delete(key);
  return (failures.get(key)?.count || 0) >= FAIL_LIMIT;
}

function recordFailure(key) {
  const f = failures.get(key);
  if (f) return void f.count++;
  if (failures.size > 10_000) {
    for (const [k, v] of failures) if (Date.now() - v.since > FAIL_WINDOW_MS) failures.delete(k);
  }
  failures.set(key, { count: 1, since: Date.now() });
}

const TOO_MANY = { error: 'Слишком много попыток. Попробуйте через 15 минут' };

/* The signature, or nothing. Returns null when initData is absent, forged,
   expired — or when TELEGRAM_BOT_TOKEN is unset, because a server that cannot
   verify a signature must refuse logins rather than wave them through. */
function identify(body) {
  const tgUser = verifyInitData(body?.initData);
  return tgUser ? Number(tgUser.id) : null;
}

function loadUser(chatId) {
  return db
    .from('users')
    .select('id, user_name, access, role, chat_id, tg_username, company_id, code_version, ' +
            'admin_session_version, user_session_version, notice_message_id, ' +
            'companies(id, company_name, access, code_version)')
    .eq('chat_id', chatId)
    .maybeSingle();
}

/* The code is never read back out of the database, so this looks the company
   up by the hash of what was typed: an exact match on a unique index, and
   nothing on the row an attacker could take away and use.

   This also retires the old ILIKE match. Matching a stored code with a
   pattern meant the wildcards `_` and `%` had to be kept out of the alphabet,
   or a code of six underscores would have matched every company in the table;
   a hash has no pattern in it to interpret. CODE_RE stays as input
   validation — it still says what a code an admin types may look like. */
async function loadCompany(code) {
  const { data, error } = await db
    .from('companies')
    .select('id, company_name, access, code_version')
    .eq('company_code_hash', hashCode(code))
    .maybeSingle();
  if (error) return { data: null, error };
  return { data: data || null, error: null };
}

/* Sign in to a company: the one this person last used, or — when that one is
   gone, blocked or has moved on to a code they have not typed — the first of
   theirs that can be used. Returns the seat, or the reason there is none.

   A stale company is not skipped over silently when it is the only one: the
   app has to say «type the new code», and it can only say that about a
   company the user is still a member of. */
async function chooseSeat(user) {
  const mine = await switchableCompanies(user.id);
  if (!mine.length) return { error: 'no_company' };

  const wanted = user.company_id
    ? mine.find((c) => c.id === user.company_id) : null;
  /* A stale seat is recoverable — typing that company's new code gets them
     back in — and a blocked one is not. Preferring stale over blocked keeps
     somebody whose seated company was shut out of a dead-end screen when
     another of their companies is only waiting for a code. */
  const seat = (wanted && wanted.state === 'ok')
    ? wanted
    : mine.find((c) => c.state === 'ok')
      || mine.find((c) => c.state === 'stale')
      || wanted || mine[0];

  if (seat.state === 'blocked') return { error: 'company_blocked' };
  if (seat.state === 'stale') return { error: 'code_rotated' };

  const active = await activate(user.id, seat.id);
  if (!active) return { error: 'no_company' };
  return { seat, user: { ...user, ...active } };
}

async function publicUser(user, companyName) {
  return {
    id: user.id,
    user_name: user.user_name,
    role: user.role,
    company_id: user.company_id,
    company_name: companyName ?? user.companies?.company_name ?? null,
    // the switcher: one entry means the app draws no switcher at all
    companies: await switchableCompanies(user.id)
  };
}

const touch = (id) =>
  db.from('users').update({ last_login: new Date().toISOString() }).eq('id', id);

/* ---------- admin panel ---------- */

/* An admin is a user whose company code they know and whose row says 'admin'.
   Every rejection returns the same message: never confirm which half matched. */
authRouter.post('/admin/login', async (req, res) => {
  const code = String(req.body?.code || '').trim();
  const chatId = String(req.body?.chat_id || '').trim();
  if (!code || !chatId) return res.status(400).json({ error: 'Chat ID and code required' });
  const limitKey = `admin:${req.ip}`;
  if (throttled(limitKey)) return res.status(429).json(TOO_MANY);
  if (!CODE_RE.test(code) || !CHAT_RE.test(chatId)) {
    recordFailure(limitKey);
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const [{ data: user, error }, { data: company, error: cErr }] =
    await Promise.all([loadUser(Number(chatId)), loadCompany(code)]);
  if (error) return dbError(res, error, 500);
  if (cErr) return dbError(res, cErr, 500);

  /* Any of the admin's own companies' codes will do. They may hold several,
     and being made to remember which one the panel was keyed to would be an
     accident waiting to happen rather than a security property. */
  const ok = user && company &&
    user.role === 'admin' &&
    await isMember(user.id, company.id) &&
    user.access !== false &&
    company.access !== false;
  if (!ok) {
    recordFailure(limitKey);
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  failures.delete(limitKey);

  await touch(user.id);
  res.cookie(
    ADMIN_COOKIE,
    sign({ role: 'admin', id: user.id, name: user.user_name, sv: user.admin_session_version }, '12h'),
    cookieOpts(12 * 3600 * 1000)
  );
  res.json({ ok: true, id: user.id, user_name: user.user_name });
});

authRouter.post('/admin/logout', async (req, res) => {
  await revokeSessions(req.cookies?.[ADMIN_COOKIE], 'admin');
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
  /* No signature, no session. This used to fall back to a typed chat id,
     which made a public identifier sufficient on its own to be handed a
     thirty-day session as anybody on the roster. */
  const chatId = identify(req.body);
  if (chatId === null) return res.status(401).json({ error: 'need_telegram' });

  const { data: user, error } = await loadUser(chatId);
  if (error) return dbError(res, error, 500);
  if (!user) return res.status(404).json({ error: 'not_registered' });

  /* Ahead of the approval check on purpose: under the new registration a
     person who has not yet entered a code is not waiting on anybody, they
     are waiting on themselves, and must be told to type the code. */
  let chosen;
  try {
    chosen = await chooseSeat(user);
  } catch (e) {
    return dbError(res, e, 500);
  }
  if (chosen.error === 'no_company') return res.status(409).json({ error: 'no_company' });
  if (user.access === false) return res.status(403).json({ error: 'pending' });
  if (chosen.error === 'company_blocked') {
    return res.status(403).json({ error: 'company_blocked' });
  }
  if (chosen.error === 'code_rotated') return res.status(409).json({ error: 'code_rotated' });

  await touch(user.id);
  issueSession(res, chosen.user);
  res.json(await publicUser(chosen.user, chosen.seat.company_name));
});

/* The company code: joining on first use, and coming back after a rotation.

   The user must already exist — /start is what creates them — but they need
   not be approved yet, because entering the code is a step of registering
   rather than a reward for having registered. An unapproved user who gets
   the code right is attached to the company and announced to the operators;
   they still leave here without a session. */
authRouter.post('/user/join', async (req, res) => {
  /* Both halves or neither: the signature says who, the code says which
     company, and this endpoint issues a session only when it has checked
     the two of them together. */
  const chatId = identify(req.body);
  if (chatId === null) return res.status(401).json({ error: 'need_telegram' });

  const code = String(req.body?.code || '').trim();
  if (!code) return res.status(400).json({ error: 'Введите код компании' });
  const limitKey = `join:${chatId}`;
  if (throttled(limitKey)) return res.status(429).json(TOO_MANY);
  if (!CODE_RE.test(code)) {
    recordFailure(limitKey);
    return res.status(401).json({ error: 'Неверный код' });
  }

  const { data: user, error } = await loadUser(chatId);
  if (error) return dbError(res, error, 500);
  if (!user) return res.status(404).json({ error: 'not_registered' });

  const { data: company, error: cErr } = await loadCompany(code);
  if (cErr) return dbError(res, cErr, 500);
  if (!company) {
    recordFailure(limitKey);
    return res.status(401).json({ error: 'Неверный код' });
  }
  failures.delete(limitKey);
  if (company.access === false) return res.status(403).json({ error: 'company_blocked' });

  /* Three ways to arrive here, and only the middle one is new:

     — already a member: the code was typed to come back after a rotation, and
       the membership is re-stamped with the generation just typed;
     — a member of somewhere else: this is a second company, allowed only
       where the operator has switched that on. Otherwise the code belongs to
       somebody else's company as far as this person is concerned;
     — a member of nowhere: registering, as before. */
  const already = await isMember(user.id, company.id);
  if (!already) {
    const hasAny = (await switchableCompanies(user.id)).length > 0;
    if (hasAny && !(await authSettings()).allow_multi_company_join) {
      return res.status(403).json({ error: 'Этот код принадлежит другой компании' });
    }
  }

  /* Nobody is promoted by being early. Whoever registers first would
     otherwise own the company — and, where owners may reissue the code, hold
     its kill switch — on no better evidence than having typed fastest. An
     admin names the owner in the panel. */
  let joined;
  try {
    joined = await joinCompany(user.id, company.id, company.code_version ?? 1,
                               { role: 'employee' });
  } catch (e) {
    return dbError(res, e, 500);
  }

  const updated = await activate(user.id, company.id);
  if (!updated) return res.status(500).json({ error: 'Не удалось войти в компанию' });
  await touch(user.id);

  /* The operators hear about a person when they name a company they were not
     in. Coming back after a rotation is not a new request — they are already
     on the roster and already approved — but a second company is: it puts
     that person in front of a different set of orders. */
  if (joined) {
    await sendNewUserNotice(
      { ...updated, chat_id: user.chat_id, tg_username: user.tg_username,
        access: user.access, notice_message_id: user.notice_message_id },
      company.company_name
    );
  }

  // Attached, announced, and still waiting on an operator.
  if (user.access === false) return res.status(403).json({ error: 'pending' });

  issueSession(res, updated);
  res.json(await publicUser(updated, company.company_name));
});

authRouter.post('/user/logout', async (req, res) => {
  await revokeSessions(req.cookies?.[USER_COOKIE], 'user');
  res.clearCookie(USER_COOKIE, { path: '/' });
  res.json({ ok: true });
});

/* Who the cookie says you are, and which company it says you are in.
   requireUser has already checked that the membership is real and the
   company open; what is left is the person themselves. */
authRouter.get('/user/me', requireUser, async (req, res) => {
  const { data, error } = await db
    .from('users').select('id, user_name, access, role')
    .eq('id', req.user.id).maybeSingle();
  if (error) return dbError(res, error, 500);

  let seat;
  try {
    seat = await membership(req.user.id, req.user.company_id);
  } catch (e) {
    return dbError(res, e, 500);
  }

  /* A stale code fails the same way as the rest: the app drops back to
     /user/telegram, which is the one place that says precisely what went
     wrong and gets the right screen drawn. */
  if (!data || data.access === false || !seat || membershipState(seat) !== 'ok') {
    res.clearCookie(USER_COOKIE, { path: '/' });
    return res.status(401).json({ error: 'Not authenticated' });
  }
  res.json(await publicUser(
    { ...data, role: seat.role, company_id: seat.company_id }, seat.company_name));
});
