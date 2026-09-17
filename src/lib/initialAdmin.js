import { pool } from './db.js';
import { CODE_RE, hashCode } from './companyCode.js';

/* The first admin, from .env.

   A new database without a Supabase load has nobody to sign in with, and
   admins can only be made from inside the panel. ADMIN_CHAT_ID and
   ADMIN_PASSWORD fix that: at start, if no user has that chat id yet, the
   server creates one as admin — in the company whose password is
   ADMIN_PASSWORD, or in a new company with that password.

   A chat id that is already here is never touched, so imported data and
   whatever was changed in the panel win. Deleting that user and restarting
   brings them back, which doubles as a way back in. */

const CHAT_RE = /^-?\d{1,20}$/;

export async function ensureInitialAdmin() {
  const chatId = String(process.env.ADMIN_CHAT_ID || '').trim();
  const code = String(process.env.ADMIN_PASSWORD || '').trim();
  if (!chatId && !code) return;
  if (!CHAT_RE.test(chatId)) {
    return console.warn(`[admin] ADMIN_CHAT_ID ${chatId ? 'must be digits' : 'is not set'} — no admin created`);
  }
  if (!CODE_RE.test(code)) {
    return console.warn(`[admin] ADMIN_PASSWORD ${code ? 'may only have latin letters, digits and "-", up to 32' : 'is not set'} — no admin created`);
  }

  const client = await pool.connect();
  try {
    await client.query('begin');
    const { rows: users } = await client.query('select id from users where chat_id = $1', [chatId]);
    if (users.length) return await client.query('rollback');

    /* ADMIN_PASSWORD is a company code like any other, so it is matched and
       stored the same way: by hash, never in the table in the clear. It does
       still sit in .env in the clear — that file is the server's own secret
       store, and this variable only matters until the first admin exists. */
    const codeHash = hashCode(code);
    let { rows: [company] } = await client.query(
      'select id, code_version from companies where company_code_hash = $1', [codeHash]);
    if (!company) {
      ({ rows: [company] } = await client.query(
        `insert into companies (company_name, company_code_hash, access)
         values ('Good Food', $1, true) returning id, code_version`, [codeHash]));
    }

    await client.query(
      `insert into users (user_name, role, access, chat_id, company_id, code_version)
       values ('Администратор', 'admin', true, $1, $2, $3)`,
      [chatId, company.id, company.code_version]);
    await client.query('commit');
    console.log(`[admin] created admin with chat id ${chatId}`);
  } catch (e) {
    await client.query('rollback').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
