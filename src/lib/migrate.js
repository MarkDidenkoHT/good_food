import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, forgetCatalog } from './db.js';

/* Brings the database up to the schema the code expects, on every start.

   db/migrations/NNN_name.sql run once each, in order, each in its own
   transaction, and are recorded in schema_migrations. A fresh volume gets the
   whole schema from 001; a later change is a new numbered file, never an edit
   to one that has already run somewhere. */

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../db/migrations');
const NAME = /^\d{3}_[\w-]+\.sql$/;
const LOCK = 727465;             // any constant; keeps two servers from migrating at once

export async function migrate({ attempts = 30 } = {}) {
  await waitForDatabase(attempts);

  const client = await pool.connect();
  try {
    await client.query('select pg_advisory_lock($1)', [LOCK]);
    await client.query(`
      create table if not exists schema_migrations (
        name       text primary key,
        applied_at timestamptz not null default now()
      )`);

    const { rows } = await client.query('select name from schema_migrations');
    const done = new Set(rows.map((r) => r.name));
    const files = (await fs.readdir(DIR)).filter((f) => NAME.test(f)).sort();

    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await fs.readFile(path.join(DIR, file), 'utf8');
      console.log(`[db] applying ${file}`);
      try {
        await client.query('begin');
        await client.query(sql);
        await client.query('insert into schema_migrations (name) values ($1)', [file]);
        await client.query('commit');
      } catch (e) {
        await client.query('rollback');
        throw new Error(`${file}: ${e.message}`);
      }
    }
  } finally {
    await client.query('select pg_advisory_unlock($1)', [LOCK]).catch(() => {});
    client.release();
    forgetCatalog();
  }
}

/* On a cold start Docker brings Postgres and the server up together; the
   healthcheck usually covers it, but a restart of Postgres alone does not. */
async function waitForDatabase(attempts) {
  for (let i = 1; ; i++) {
    try {
      await pool.query('select 1');
      return;
    } catch (e) {
      if (i >= attempts) throw e;
      console.warn(`[db] not reachable yet (${e.message}) — retrying`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}
