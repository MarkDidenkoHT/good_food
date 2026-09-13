/* The whole app on this computer, without Docker: a portable Postgres (from
 * the embedded-postgres dev dependency) plus the server.
 *
 *   npm run local                         start Postgres and the server
 *   npm run local:import [-- --replace]   copy the data from Supabase into it
 *   npm run local:stop                    stop a Postgres left running
 *
 * Everything it keeps lives in .local/: the database, the pictures, the
 * backups and the Postgres log. Delete the folder to start from scratch. Settings come from .env.
 */

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import pg from 'pg';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCAL = path.join(ROOT, '.local');
const DATA = path.join(LOCAL, 'pgdata');
const LOG = path.join(LOCAL, 'postgres.log');

dotenv.config({ path: path.join(ROOT, '.env'), quiet: true });

const PG_PORT = Number(process.env.LOCAL_PG_PORT) || 5433;

function binDir() {
  const platform = { win32: 'windows', darwin: 'darwin', linux: 'linux' }[process.platform];
  const dir = path.join(ROOT, 'node_modules', '@embedded-postgres', `${platform}-${process.arch}`, 'native', 'bin');
  if (!fs.existsSync(dir)) fail(`No portable Postgres for ${process.platform}-${process.arch} — run npm install first.`);
  return dir;
}

const bin = (name) => path.join(binDir(), process.platform === 'win32' ? `${name}.exe` : name);

function isRunning() {
  try {
    execFileSync(bin('pg_ctl'), ['status', '-D', DATA], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

async function startPostgres() {
  fs.mkdirSync(LOCAL, { recursive: true });

  if (!fs.existsSync(path.join(DATA, 'PG_VERSION'))) {
    console.log('[local] creating the database in .local/pgdata …');
    execFileSync(bin('initdb'),
      ['-D', DATA, '-U', 'goodfood', '-A', 'trust', '-E', 'UTF8', '--locale=C'], { stdio: 'ignore' });
  }

  if (isRunning()) {
    console.log('[local] Postgres is already running');
  } else {
    console.log(`[local] starting Postgres on 127.0.0.1:${PG_PORT} …`);
    // pg_ctl rather than postgres itself: on Windows it drops administrator
    // rights, which Postgres refuses to run with. Output goes to the log, and
    // stdio is ignored so the background server does not hold this process.
    try {
      execFileSync(bin('pg_ctl'),
        ['start', '-w', '-D', DATA, '-l', LOG, '-o', `-p ${PG_PORT} -h 127.0.0.1`], { stdio: 'ignore' });
    } catch {
      fail('Postgres did not start — see .local/postgres.log');
    }
  }

  const admin = new pg.Client({ connectionString: `postgres://goodfood@127.0.0.1:${PG_PORT}/postgres` });
  await admin.connect();
  const { rows } = await admin.query(`select 1 from pg_database where datname = 'goodfood'`);
  if (!rows.length) await admin.query('create database goodfood');
  await admin.end();
}

function stopPostgres() {
  if (!isRunning()) return;
  try {
    execFileSync(bin('pg_ctl'), ['stop', '-D', DATA, '-m', 'fast'], { stdio: 'ignore' });
    console.log('[local] Postgres stopped');
  } catch {
    console.error('[local] could not stop Postgres — see .local/postgres.log');
  }
}

function fail(message) {
  console.error(`[local] ${message}`);
  process.exit(1);
}

/* ── main ─────────────────────────────────────────────────────────────── */

const [script, ...args] = process.argv.slice(2);

if (script === 'stop') {
  stopPostgres();
  process.exit(0);
}

await startPostgres();

const env = {
  ...process.env,
  DATABASE_URL: `postgres://goodfood@127.0.0.1:${PG_PORT}/goodfood`,
  UPLOADS_DIR: path.join(LOCAL, 'uploads'),
  BACKUP_DIR: path.join(LOCAL, 'backups'),
  PORT: process.env.PORT || '3000',
  // plain http on localhost: Secure cookies would never come back
  NODE_ENV: 'development'
};

if (!script) console.log(`[local] admin panel: http://localhost:${env.PORT}/admin`);

const child = spawn(process.execPath, script ? [script, ...args] : ['server.js'], {
  cwd: ROOT, env, stdio: 'inherit'
});

// Ctrl+C reaches the server too; wait for it to finish rather than leaving
// it without a database halfway through
process.on('SIGINT', () => {});
process.on('SIGTERM', () => child.kill('SIGTERM'));

child.on('exit', (code) => {
  stopPostgres();
  process.exit(code ?? 0);
});
