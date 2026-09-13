import fs from 'node:fs/promises';
import path from 'node:path';
import { ROOT as UPLOADS, resolvePath } from './storage.js';
import { TABLES, tablesWithData, replaceAll } from './dataset.js';
import { exclusive, snapshot, walk } from './backups.js';
import { forgetPublicUrl } from './publicUrl.js';

/* Loading everything from Supabase into this server's own database.

   Reads every table through Supabase's REST API with the service_role key
   (SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env — no database password
   needed) and the pictures from the item_images bucket, then replaces all the
   data here with it. Nothing on Supabase is changed.

   Three ways in:
   - a new, empty database loads by itself when the server starts
     (importIfEmpty) — otherwise there is no admin to sign in with;
   - the button in Настройки, for the final load before switching over. Only
     this one writes the 'supabase_import' flag, and the flag takes the button
     away;
   - scripts/import-supabase.js, to run it again on purpose. */

const BUCKET = 'item_images';
const PAGE = 1000;
export const IMPORT_FLAG = 'supabase_import';

const base = () => (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const headers = () => {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  return { apikey: key, Authorization: `Bearer ${key}` };
};

export const supabaseConfigured = () =>
  Boolean(base() && process.env.SUPABASE_SERVICE_ROLE_KEY);

const refuse = (status, message) => Object.assign(new Error(message), { status });

/* Loads Supabase into an empty database, once, at start. Does nothing when
   there is data already or no keys; a failed load is tried again at the
   next start. */
export async function importIfEmpty() {
  if (!supabaseConfigured()) return false;
  if ((await tablesWithData()).length) return false;
  console.log('[import] the database is empty — loading from Supabase');
  await importFromSupabase({ markDone: false });
  return true;
}

export async function importFromSupabase({ log = (m) => console.log(`[import] ${m}`), markDone = true } = {}) {
  if (!supabaseConfigured()) {
    throw refuse(400, 'В .env не заданы SUPABASE_URL и SUPABASE_SERVICE_ROLE_KEY');
  }

  return exclusive(async () => {
    log(`reading ${base()}`);
    const data = {};
    for (const [t, pk] of TABLES) data[t] = await fetchTable(t, pk);
    log(`rows: ${TABLES.map(([t]) => `${t} ${data[t].length}`).join(', ')}`);

    // Everything is fetched before anything here changes, so a Supabase that
    // stops answering halfway leaves this server exactly as it was. Pictures
    // are only added at this point; the ones no longer needed go after the swap.
    const pictures = await fetchPictures(data, log);

    const backup = (await tablesWithData()).length ? await snapshot('pre-import') : null;
    if (backup) log(`current data saved as backup ${backup.id}`);

    const skipped = await replaceAll(data, {
      keepLocalSettings: true,
      settings: markDone ? [{ key: IMPORT_FLAG, value: { done_at: new Date().toISOString() } }] : []
    });
    for (const [t, cols] of Object.entries(skipped)) {
      log(`${t}: not imported (no such column here): ${cols.join(', ')}`);
    }

    for await (const rel of walk(UPLOADS)) {
      if (!pictures.stored.has(rel)) await fs.rm(path.join(UPLOADS, ...rel.split('/')), { force: true });
    }
    forgetPublicUrl();

    log('done');
    return {
      rows: Object.fromEntries(TABLES.map(([t]) => [t, data[t].length])),
      pictures: { copied: pictures.copied, failed: pictures.failed, missing: pictures.missing },
      backup: backup?.id || null
    };
  });
}

async function fetchTable(table, pk) {
  const rows = [];
  for (let offset = 0; ; offset += PAGE) {
    const url = `${base()}/rest/v1/${table}?select=*&order=${pk}.asc&offset=${offset}&limit=${PAGE}`;
    const res = await fetch(url, { headers: headers() });
    if (!res.ok) throw new Error(`Supabase, ${table}: HTTP ${res.status} ${await res.text()}`);
    const page = await res.json();
    rows.push(...page);
    if (page.length < PAGE) return rows;
  }
}

async function fetchPictures(data, log) {
  const paths = (await listBucket('')).filter((p) => !path.basename(p).startsWith('.'));

  let copied = 0;
  let failed = 0;
  const stored = new Set();
  for (const rel of paths) {
    const target = resolvePath(rel);
    if (!target) {
      log(`skipped ${rel}: unsupported file name`);
      failed++;
      continue;
    }
    const url = `${base()}/storage/v1/object/${BUCKET}/${rel.split('/').map(encodeURIComponent).join('/')}`;
    const res = await fetch(url, { headers: headers() });
    if (!res.ok) {
      log(`${rel}: HTTP ${res.status}`);
      failed++;
      continue;
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, Buffer.from(await res.arrayBuffer()));
    stored.add(rel);
    copied++;
  }
  log(`pictures: ${copied} copied${failed ? `, ${failed} failed` : ''}`);

  // a row pointing at a picture the bucket never had shows up as a blank tile
  const referenced = [
    ...(data.items || []).map((r) => r.image_path),
    ...(data.categories || []).map((r) => r.image_path),
    ...(data.broadcasts || []).map((r) => r.image_path),
    ...(data.app_settings || []).filter((r) => r.key === 'design').map((r) => r.value?.background_path)
  ].filter(Boolean);
  const missing = [...new Set(referenced)].filter((p) => !stored.has(p));
  if (missing.length) log(`${missing.length} picture(s) referenced but not in the bucket: ${missing.join(', ')}`);

  return { stored, copied, failed, missing: missing.length };
}

async function listBucket(prefix) {
  const out = [];
  for (let offset = 0; ; offset += PAGE) {
    const res = await fetch(`${base()}/storage/v1/object/list/${BUCKET}`, {
      method: 'POST',
      headers: { ...headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefix, limit: PAGE, offset, sortBy: { column: 'name', order: 'asc' } })
    });
    if (!res.ok) throw new Error(`Supabase storage "${prefix}": HTTP ${res.status} ${await res.text()}`);
    const page = await res.json();
    for (const entry of page) {
      const full = prefix ? `${prefix}/${entry.name}` : entry.name;
      // folders come back without an id
      if (entry.id === null) out.push(...await listBucket(full));
      else out.push(full);
    }
    if (page.length < PAGE) return out;
  }
}
