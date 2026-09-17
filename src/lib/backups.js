import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import { pool } from './db.js';
import { ROOT as UPLOADS } from './storage.js';
import { TABLES, readAll, replaceAll } from './dataset.js';
import { TZ, localNow } from './orders.js';
import { forgetPublicUrl } from './publicUrl.js';

/* Резервные копии.

   Every day at 03:00 (and whenever an admin asks) the server writes all of
   its data and pictures into BACKUP_DIR, one folder per backup:

     2026-09-14_030005_daily/
       meta.json       when, what kind, row counts, schema version
       data.json.gz    every table
       uploads/        the pictures

   Plain files rather than pg_dump, so a backup is the same thing with Docker
   and without it. Backups older than 30 days are removed; the newest is always kept.

   Restoring saves the current data as a backup first, so a restore made by
   mistake can itself be undone. */

export const BACKUP_ROOT = path.resolve(process.env.BACKUP_DIR || 'data/backups');

const KEEP_DAYS = 30;
const DAILY_AT_MIN = 3 * 60;
const ID = /^\d{4}-\d{2}-\d{2}_\d{6}_(daily|manual|pre-restore|pre-import)$/;

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

const STAMP = new Intl.DateTimeFormat('sv-SE', {
  timeZone: TZ, hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit'
});

// '2026-09-14_030005', local time
const stamp = (at = new Date()) => {
  const [day, time] = STAMP.format(at).split(' ');
  return `${day}_${time.replace(/:/g, '')}`;
};

const join = (root, rel) => path.join(root, ...rel.split('/'));

const refuse = (status, message) => Object.assign(new Error(message), { status });

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

const exists = (p) => fs.access(p).then(() => true, () => false);

/* Windows refuses to rename a folder while something — usually the virus
   scanner reading the files just written — still has one open. It lets go
   within moments, so try again for a few seconds before giving up. */
async function renameWhenFree(from, to) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fs.rename(from, to);
    } catch (e) {
      if (attempt >= 20 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
      await pause(250);
    }
  }
}

/* ── one at a time ────────────────────────────────────────────────────── */

/* A backup and a restore each read or replace everything, so none of them may overlap. A second one is refused rather
   than queued: the admin who pressed the button should hear that something
   is already running. */
let busy = false;

async function exclusive(fn) {
  if (busy) throw refuse(409, 'Уже идёт резервное копирование или восстановление — подождите');
  busy = true;
  try {
    return await fn();
  } finally {
    busy = false;
  }
}

/* ── making one ───────────────────────────────────────────────────────── */

export const createBackup = (kind = 'manual') => exclusive(() => snapshot(kind));

/* The backup itself, for callers already holding exclusive(). Written into a
   .partial folder and renamed at the end, so a backup that died halfway is
   never listed or restored. */
async function snapshot(kind, { protect = null } = {}) {
  let id = `${stamp()}_${kind}`;
  // two backups of one kind in the same second would share a name
  while (await exists(path.join(BACKUP_ROOT, id))) {
    await pause(1000);
    id = `${stamp()}_${kind}`;
  }
  const dir = path.join(BACKUP_ROOT, id);
  const partial = `${dir}.partial`;
  await fs.mkdir(partial, { recursive: true });

  try {
    const previous = (await listBackups())[0];
    const data = await readAll();
    const { rows } = await pool.query('select name from schema_migrations order by name');

    const packed = await gzip(JSON.stringify(data));
    await fs.writeFile(path.join(partial, 'data.json.gz'), packed);

    const files = await copyUploads(UPLOADS, path.join(partial, 'uploads'),
      previous ? path.join(BACKUP_ROOT, previous.id, 'uploads') : null);

    const meta = {
      id,
      kind,
      created_at: new Date().toISOString(),
      migrations: rows.map((r) => r.name),
      rows: Object.fromEntries(TABLES.map(([t]) => [t, data[t].length])),
      files: files.count,
      bytes: packed.length + files.bytes
    };
    await fs.writeFile(path.join(partial, 'meta.json'), JSON.stringify(meta, null, 2));
    await renameWhenFree(partial, dir);
    console.log(`[backup] ${id}: ${meta.rows.orders} orders, ${meta.files} pictures`);

    await prune(protect).catch((e) => console.error('[backup] cleanup failed:', e.message));
    return meta;
  } catch (e) {
    await fs.rm(partial, { recursive: true, force: true }).catch(() => {});
    throw e;
  }
}

/* Pictures never change under the same name, so one that is already in the
   previous backup is hard-linked rather than copied again: thirty days of
   history cost about one copy of the pictures. Anything a link cannot be made
   for is simply copied. */
async function copyUploads(src, dst, previous) {
  let count = 0;
  let bytes = 0;
  for await (const rel of walk(src)) {
    const from = join(src, rel);
    const to = join(dst, rel);
    const { size } = await fs.stat(from);
    await fs.mkdir(path.dirname(to), { recursive: true });

    const old = previous ? join(previous, rel) : null;
    const same = old && (await fs.stat(old).catch(() => null))?.size === size;
    if (same) {
      await fs.link(old, to).catch(() => fs.copyFile(from, to));
    } else {
      await fs.copyFile(from, to);
    }
    count++;
    bytes += size;
  }
  return { count, bytes };
}

/* Relative paths of every file under `dir`, '/'-separated; nothing when the
   folder does not exist yet. */
async function* walk(dir, rel = '') {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (e) {
    if (e.code === 'ENOENT') return;
    throw e;
  }
  for (const entry of entries) {
    const next = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) yield* walk(path.join(dir, entry.name), next);
    else if (entry.isFile()) yield next;
  }
}

/* ── the daily one ────────────────────────────────────────────────────── */

/* Called on every scheduler tick. Due once the local clock is past 03:00 and
   today has no daily backup yet — so a server that was off at 03:00 makes
   it as soon as it is back the same day. */
export async function dailyBackupIfDue(at = new Date()) {
  const now = localNow(at);
  if (now.minutes < DAILY_AT_MIN || busy) return null;
  const done = (await listBackups()).some((b) => b.kind === 'daily' && b.id.startsWith(now.date));
  if (done) return null;
  return createBackup('daily');
}

/* ── listing and cleaning up ─────────────────────────────────────────── */

export async function listBackups() {
  let names = [];
  try {
    names = await fs.readdir(BACKUP_ROOT);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }

  const out = [];
  for (const name of names.filter((n) => ID.test(n))) {
    try {
      out.push(JSON.parse(await fs.readFile(path.join(BACKUP_ROOT, name, 'meta.json'), 'utf8')));
    } catch {
      // a folder without readable meta is not a backup anyone can restore
    }
  }
  return out.sort((a, b) => b.id.localeCompare(a.id));
}

async function prune(protect) {
  const cutoff = Date.now() - KEEP_DAYS * 24 * 3600 * 1000;
  const all = await listBackups();

  // the newest always stays, however old: it may be the only one there is
  for (const b of all.slice(1)) {
    if (b.id === protect) continue;
    if (new Date(b.created_at).getTime() < cutoff) {
      await fs.rm(path.join(BACKUP_ROOT, b.id), { recursive: true, force: true });
      console.log(`[backup] removed ${b.id} (older than ${KEEP_DAYS} days)`);
    }
  }

  // leftovers of a backup that died halfway, once they are clearly not running
  for (const name of await fs.readdir(BACKUP_ROOT)) {
    if (!name.endsWith('.partial')) continue;
    const full = path.join(BACKUP_ROOT, name);
    const { mtimeMs } = await fs.stat(full);
    if (Date.now() - mtimeMs > 24 * 3600 * 1000) await fs.rm(full, { recursive: true, force: true });
  }
}

/* ── restoring ────────────────────────────────────────────────────────── */

export const restoreBackup = (id) => exclusive(async () => {
  if (!ID.test(String(id))) throw refuse(404, 'Копия не найдена');
  const dir = path.join(BACKUP_ROOT, id);

  let meta;
  try {
    meta = JSON.parse(await fs.readFile(path.join(dir, 'meta.json'), 'utf8'));
  } catch {
    throw refuse(404, 'Копия не найдена');
  }

  // A backup from a newer version may carry columns this code knows nothing
  // about. An older one is fine: new columns simply take their defaults.
  const { rows } = await pool.query('select name from schema_migrations');
  const known = new Set(rows.map((r) => r.name));
  if ((meta.migrations || []).some((m) => !known.has(m))) {
    throw refuse(409, 'Копия сделана более новой версией программы');
  }

  const data = JSON.parse((await gunzip(await fs.readFile(path.join(dir, 'data.json.gz')))).toString('utf8'));

  const safety = await snapshot('pre-restore', { protect: id });
  await replaceAll(data);
  await mirror(path.join(dir, 'uploads'), UPLOADS);
  forgetPublicUrl();

  console.log(`[backup] restored ${id}; the data before it is in ${safety.id}`);
  return { restored: id, rows: meta.rows, files: meta.files, safety: safety.id };
});

/* Makes `dst` hold exactly the files of `src`: missing or different ones are
   copied, extra ones removed. */
async function mirror(src, dst) {
  const wanted = new Set();
  for await (const rel of walk(src)) {
    wanted.add(rel);
    const from = join(src, rel);
    const to = join(dst, rel);
    const [a, b] = await Promise.all([fs.stat(from), fs.stat(to).catch(() => null)]);
    if (b && b.size === a.size) continue;
    await fs.mkdir(path.dirname(to), { recursive: true });
    await fs.copyFile(from, to);
  }
  for await (const rel of walk(dst)) {
    if (!wanted.has(rel)) await fs.rm(join(dst, rel), { force: true });
  }
}
