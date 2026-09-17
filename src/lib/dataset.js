import { pool } from './db.js';
import { backfillCodeHashes } from './companyCode.js';

/* Every table of the app's data, and the two things done with all of them at
   once: reading them out (a backup) and putting a whole set back (restoring a
   backup).

   Parents come before children, so on the way in every foreign key finds its
   row. */

export const TABLES = [
  ['companies', 'id'],
  ['users', 'id'],
  ['categories', 'id'],
  ['materials', 'id'],
  ['items', 'id'],
  ['reminders', 'id'],
  ['orders', 'id'],
  ['broadcasts', 'id'],
  ['broadcast_targets', 'id'],
  ['reminder_runs', 'id'],
  ['frontpad_log', 'id'],
  ['app_settings', 'key'],
  ['admin_prefs', 'admin_key']
];

const JSON_TYPES = new Set(['json', 'jsonb']);

/* Every row of every table, as of one moment: a backup taken while an order
   is being placed has either all of it or none of it. */
export async function readAll() {
  const client = await pool.connect();
  try {
    await client.query('begin isolation level repeatable read read only');
    const data = {};
    for (const [t, pk] of TABLES) {
      data[t] = (await client.query(`select * from "${t}" order by "${pk}"`)).rows;
    }
    await client.query('commit');
    return data;
  } catch (e) {
    await client.query('rollback').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/* Replaces everything with `data`, in one transaction: all of it lands or
   none of it does, and the running app never sees half.

   Columns `data` has and this schema does not are left out and reported;
   columns this schema has and `data` does not take their defaults. */
export async function replaceAll(data) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const columns = await localColumns(client);

    await client.query(`truncate ${TABLES.map(([t]) => `"${t}"`).join(', ')} restart identity cascade`);

    const skipped = {};
    for (const [t, pk] of TABLES) {
      const missing = await insertRows(client, t, data[t] || [], columns.get(t));
      if (missing.length) skipped[t] = missing;
      if (pk === 'id') {
        await client.query(
          `select setval(pg_get_serial_sequence('"${t}"', 'id'),
                         coalesce((select max(id) from "${t}"), 0) + 1, false)`);
      }
    }

    // backups taken before codes were hashed hand them over in clear text;
    // hash them before this commits, or nobody could log in until a restart
    await backfillCodeHashes(client);

    await client.query('commit');
    return skipped;
  } catch (e) {
    await client.query('rollback').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function localColumns(client) {
  const { rows } = await client.query(`
    select table_name, column_name, udt_name
      from information_schema.columns
     where table_schema = 'public'`);
  const out = new Map();
  for (const r of rows) {
    if (!out.has(r.table_name)) out.set(r.table_name, new Map());
    out.get(r.table_name).set(r.column_name, r.udt_name);
  }
  return out;
}

async function insertRows(client, table, rows, columns) {
  if (!rows.length) return [];
  const present = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const keys = present.filter((k) => columns.has(k));
  const skipped = present.filter((k) => !columns.has(k));

  for (let i = 0; i < rows.length; i += 200) {
    const params = [];
    const values = rows.slice(i, i + 200).map((row) => `(${keys.map((k) => {
      const v = row[k];
      params.push(v === null || v === undefined ? null
        : JSON_TYPES.has(columns.get(k)) ? JSON.stringify(v) : v);
      return `$${params.length}`;
    }).join(', ')})`);
    await client.query(
      `insert into "${table}" (${keys.map((k) => `"${k}"`).join(', ')}) values ${values.join(', ')}`,
      params);
  }
  return skipped;
}
