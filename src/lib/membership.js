import { pool } from './db.js';
import { forgetCompany } from './companyCode.js';

/* Who belongs to which company.

   user_companies is the roster; users.company_id is only the company a person
   is signed in to right now. Everything that asks "who is in this company"
   belongs here, and everything that asks "which company is this request
   about" goes on reading req.user.company_id as it always did.

   These are raw queries on purpose: lib/db.js speaks the supabase-js dialect
   the routes were written in, and that dialect has many-to-one embeds only —
   a user with several companies is exactly the shape it cannot express. */

/* Every membership of one user, with enough of the company on each row to
   say whether it can be used right now. */
export async function membershipsOf(userId) {
  const { rows } = await pool.query(
    `select m.company_id, m.role, m.code_version,
            c.company_name, c.access, c.code_version as company_code_version
       from user_companies m
       join companies c on c.id = m.company_id
      where m.user_id = $1
      order by c.company_name nulls last, m.company_id`,
    [userId]);
  return rows;
}

/* Blocked companies are not offered; a stale one is, because the way back in
   is to type that company's new code and the app has to show it to say so. */
export function membershipState(row) {
  if (row.access === false) return 'blocked';
  if ((row.code_version ?? 0) < (row.company_code_version ?? 1)) return 'stale';
  return 'ok';
}

/* The switcher's list. */
export async function switchableCompanies(userId) {
  return (await membershipsOf(userId)).map((row) => ({
    id: row.company_id,
    company_name: row.company_name,
    role: row.role,
    state: membershipState(row)
  }));
}

export async function membership(userId, companyId) {
  const { rows } = await pool.query(
    `select m.company_id, m.role, m.code_version,
            c.company_name, c.access, c.code_version as company_code_version
       from user_companies m
       join companies c on c.id = m.company_id
      where m.user_id = $1 and m.company_id = $2`,
    [userId, companyId]);
  return rows[0] || null;
}

export async function isMember(userId, companyId) {
  const { rows } = await pool.query(
    'select 1 from user_companies where user_id = $1 and company_id = $2',
    [userId, companyId]);
  return rows.length > 0;
}

/* Join, or come back after a rotation: either way the membership ends up
   stamped with the generation of the code just typed. Returns true when the
   membership is new, which is what decides whether the operators hear about
   it. */
export async function joinCompany(userId, companyId, codeVersion, { role } = {}) {
  const { rows } = await pool.query(
    `insert into user_companies (user_id, company_id, role, code_version)
          values ($1, $2, coalesce($3, 'employee'), $4)
     on conflict (user_id, company_id)
       do update set code_version = excluded.code_version
       returning (xmax = 0) as inserted`,
    [userId, companyId, role || null, codeVersion]);
  return rows[0]?.inserted === true;
}

/* Sign the user in to one of their companies: users.company_id, users.role
   and users.code_version are the signed-in membership, mirrored. The caller
   has already decided the membership is usable. */
export async function activate(userId, companyId) {
  const { rows } = await pool.query(
    `update users u
        set company_id = m.company_id,
            code_version = m.code_version,
            role = case when u.role = 'admin' then 'admin' else m.role end
       from user_companies m
      where u.id = $1 and m.user_id = u.id and m.company_id = $2
      returning u.id, u.user_name, u.role, u.company_id, u.code_version,
                u.user_session_version`,
    [userId, companyId]);
  return rows[0] || null;
}

/* The roster of one or more companies, as (user, company) rows — what the
   audience of a broadcast or a reminder is really asking for. Someone signed
   in elsewhere is still on it, and the company_id here is the one the
   audience named, not the one they happen to be standing in. */
export async function membersOfCompanies(companyIds) {
  const ids = [...new Set((companyIds || []).map(Number).filter(Boolean))];
  if (!ids.length) return [];
  const { rows } = await pool.query(
    `select m.user_id, m.company_id
       from user_companies m
      where m.company_id = any($1::bigint[])
      order by m.user_id, m.company_id`,
    [ids]);
  return rows;
}

/* Every company this person belongs to, by name — what a notice has to say
   when "their company" is no longer a single answer. */
export async function companyNamesOf(userId) {
  return (await membershipsOf(userId)).map((r) => r.company_name).filter(Boolean);
}

/* Is any company of theirs still open? The admin panel is not scoped to one
   company, so closing one of an admin's companies must not shut the panel.

   A roster with nothing on it is not a closed company and does not shut it
   either: that is the state of an admin row created before any of this, and
   locking those out would be a worse failure than the one this answers. */
export async function hasOpenCompany(userId) {
  const { rows } = await pool.query(
    `select bool_or(c.access is distinct from false) as open
       from user_companies m join companies c on c.id = m.company_id
      where m.user_id = $1`,
    [userId]);
  return rows[0]?.open !== false;
}

/* Memberships of several users at once, for the users table in the panel. */
export async function membershipsByUser(userIds) {
  const ids = [...new Set((userIds || []).map(Number).filter(Boolean))];
  if (!ids.length) return {};
  const { rows } = await pool.query(
    `select m.user_id, m.company_id, m.role, c.company_name
       from user_companies m
       join companies c on c.id = m.company_id
      where m.user_id = any($1::bigint[])
      order by c.company_name nulls last, m.company_id`,
    [ids]);
  const out = {};
  for (const r of rows) {
    (out[r.user_id] ||= []).push({
      id: r.company_id, company_name: r.company_name, role: r.role
    });
  }
  return out;
}

/* What the panel saves: the exact set of companies this user belongs to.

   Memberships that survive keep the role and the code generation they had —
   re-saving the form must not quietly re-stamp somebody through a rotation
   they never typed a code for. New ones are stamped with the company's
   current generation, because an admin putting someone into a company by
   hand is the authority the code would otherwise be. */
export async function setMemberships(userId, companyIds, { roles = {} } = {}) {
  const ids = [...new Set((companyIds || []).map(Number).filter(Boolean))];

  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(
      'delete from user_companies where user_id = $1 and not (company_id = any($2::bigint[]))',
      [userId, ids]);

    for (const id of ids) {
      /* Read inside the transaction: currentVersion() answers from a 30s
         cache on the pool, and a company rotated a moment ago would stamp a
         brand-new membership with the generation it has just left behind. */
      const { rows: [company] } = await client.query(
        'select code_version from companies where id = $1', [id]);
      const version = company?.code_version;
      await client.query(
        `insert into user_companies (user_id, company_id, role, code_version)
              values ($1, $2, coalesce($3, 'employee'), $4)
         on conflict (user_id, company_id) do update
            set role = coalesce($3, user_companies.role)`,
        [userId, id, roles[id] || null, version ?? 1]);
    }
    await client.query('commit');
  } catch (e) {
    await client.query('rollback').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  return ids;
}

/* One person's role at one company, with the mirror on users.role following
   when that is the company they are signed in to. Demoting this person is
   not a statement about anybody else — it never touches another owner. */
export async function setMembershipRole(userId, companyId, role) {
  const wanted = role === 'owner' ? 'owner' : 'employee';
  if (wanted === 'owner') return setOwner(companyId, userId);

  await pool.query(
    `update user_companies set role = 'employee' where user_id = $1 and company_id = $2`,
    [userId, companyId]);
  await pool.query(
    `update users set role = 'employee'
      where id = $1 and company_id = $2 and role <> 'admin'`,
    [userId, companyId]);
}

/* One owner per company. Naming a new one demotes the previous, and the
   mirror on users.role follows for whoever is signed in there. */
export async function setOwner(companyId, userId) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(
      `update user_companies set role = 'employee'
        where company_id = $1 and role = 'owner' and ($2::bigint is null or user_id <> $2)`,
      [companyId, userId ?? null]);
    if (userId) {
      await client.query(
        `update user_companies set role = 'owner' where company_id = $1 and user_id = $2`,
        [companyId, userId]);
    }
    // users.role mirrors the membership of the company they are signed in to
    await client.query(
      `update users u set role = m.role
         from user_companies m
        where m.user_id = u.id and m.company_id = u.company_id
          and u.company_id = $1 and u.role <> 'admin' and u.role <> m.role`,
      [companyId]);
    await client.query('commit');
  } catch (e) {
    await client.query('rollback').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/* A company that is gone takes its memberships with it (on delete cascade),
   and the foreign key has already nulled users.company_id for anybody who
   was signed in there. They have to land somewhere: another of their
   companies, or — when there is none — nowhere, which is the screen that
   asks for a code. */
export async function repointOrphans() {
  await pool.query(
    `with pick as (
       select distinct on (m.user_id) m.user_id, m.company_id, m.role, m.code_version
         from user_companies m
        order by m.user_id, m.created_at, m.company_id)
     update users u
        set company_id = pick.company_id,
            code_version = pick.code_version,
            role = case when u.role = 'admin' then 'admin' else pick.role end
       from pick
      where pick.user_id = u.id
        and not exists (select 1 from user_companies m
                         where m.user_id = u.id and m.company_id = u.company_id)`);
  await pool.query(
    `update users u set company_id = null, code_version = null
      where u.company_id is not null
        and not exists (select 1 from user_companies m
                         where m.user_id = u.id and m.company_id = u.company_id)`);
}

export { forgetCompany };
