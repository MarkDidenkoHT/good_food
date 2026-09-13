import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

/* Pictures on the server's own disk, under UPLOADS_DIR (a Docker volume):
   items/…, categories/…, broadcasts/…, design/… — the same paths the Supabase
   bucket used, so imported rows point at imported files unchanged.

   Nothing here hands out a permanent URL: reads go through short-lived signed
   links, served by routes/files.js, so a picture is only as visible as the
   page that was allowed to show it. */

export const ROOT = path.resolve(process.env.UPLOADS_DIR || 'data/uploads');
const SECRET = process.env.JWT_SECRET || 'dev-insecure-secret';

const TYPES = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif'
};

const MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' };

export const MAX_BYTES = 5 * 1024 * 1024;

export function extFor(contentType) {
  return TYPES[String(contentType || '').toLowerCase()] || null;
}

/* A stored path as a file under ROOT, or null for anything that could step
   outside it. Paths come from the database and from query strings alike. */
export function resolvePath(rel) {
  const text = String(rel ?? '');
  if (!/^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*$/.test(text)) return null;
  if (text.split('/').some((s) => s === '.' || s === '..')) return null;
  const full = path.join(ROOT, ...text.split('/'));
  return full.startsWith(ROOT + path.sep) ? full : null;
}

/* Random names rather than the item id: an image is uploaded before a new
   item has an id, and a random name means replacing a picture can never be
   served from a stale cache under the same URL. */
export async function uploadImage(buffer, contentType, folder = 'items') {
  const ext = extFor(contentType);
  if (!ext) throw new Error('Поддерживаются JPEG, PNG, WebP и GIF');
  if (!buffer?.length) throw new Error('Пустой файл');
  if (buffer.length > MAX_BYTES) throw new Error('Файл больше 5 МБ');

  const rel = `${folder}/${crypto.randomUUID()}.${ext}`;
  const full = resolvePath(rel);
  if (!full) throw new Error('Неверная папка');
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, buffer, { flag: 'wx' });
  return rel;
}

/* Best effort: a missing file must never block deleting the row that
   pointed at it. */
export async function removeImage(rel) {
  if (!rel) return;
  const full = resolvePath(rel);
  if (!full) return console.error('[storage] remove refused:', rel);
  try {
    await fs.unlink(full);
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('[storage] remove failed:', rel, e.message);
  }
}

/* The picture itself, for sending to Telegram as a file. */
export async function readImage(rel) {
  const full = resolvePath(rel);
  try {
    if (!full) throw new Error('bad path');
    const buffer = await fs.readFile(full);
    const ext = path.extname(full).slice(1).toLowerCase();
    return { buffer, contentType: MIME[ext] || 'application/octet-stream', filename: path.basename(full) };
  } catch (e) {
    console.error('[storage] read failed:', rel, e.message);
    return null;
  }
}

/* ── signed links ────────────────────────────────────────────────────────
   The expiry is rounded up to a ten-minute step, so a picture keeps the same
   link for a while and the browser cache gets to do its job. A link is always
   good for at least `seconds`. */

const STEP_SEC = 600;

const sign = (rel, exp) =>
  crypto.createHmac('sha256', SECRET).update(`${rel}\n${exp}`).digest('base64url');

export function verifySignature(rel, exp, sig) {
  const e = Number(exp);
  if (!Number.isInteger(e) || e < Date.now() / 1000 || typeof sig !== 'string') return false;
  const a = Buffer.from(sign(rel, e));
  const b = Buffer.from(sig);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export async function signedUrl(rel, seconds = 3600) {
  if (!rel) return null;
  const full = resolvePath(rel);
  try {
    if (!full) throw new Error('bad path');
    await fs.access(full);
  } catch (e) {
    console.error('[storage] sign failed:', rel, e.message);
    return null;
  }
  const exp = Math.ceil((Date.now() / 1000 + seconds) / STEP_SEC) * STEP_SEC;
  return `/files/${rel}?e=${exp}&s=${sign(rel, exp)}`;
}

/* A whole catalog at once. */
export async function signedUrlMap(paths, seconds = 3600) {
  const unique = [...new Set(paths.filter(Boolean))];
  const out = {};
  await Promise.all(unique.map(async (rel) => {
    const url = await signedUrl(rel, seconds);
    if (url) out[rel] = url;
  }));
  return out;
}
