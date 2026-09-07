import crypto from 'node:crypto';
import { supabase } from './supabase.js';

/* Supabase Storage, bucket `item_images`. The bucket is private, so nothing
   here ever hands out a permanent URL: reads go through short-lived signed
   links minted with the service-role key. */

export const BUCKET = 'item_images';

const TYPES = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif'
};

export const MAX_BYTES = 5 * 1024 * 1024;

export function extFor(contentType) {
  return TYPES[String(contentType || '').toLowerCase()] || null;
}

/* Random names rather than the item id: an image is uploaded before a new
   item has an id, and a random name means replacing a picture can never be
   served from a stale cache under the same URL. */
export async function uploadImage(buffer, contentType, folder = 'items') {
  const ext = extFor(contentType);
  if (!ext) throw new Error('Поддерживаются JPEG, PNG, WebP и GIF');
  if (!buffer?.length) throw new Error('Пустой файл');
  if (buffer.length > MAX_BYTES) throw new Error('Файл больше 5 МБ');

  const path = `${folder}/${crypto.randomUUID()}.${ext}`;
  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(path, buffer, { contentType, upsert: false });
  if (error) throw error;
  return path;
}

/* Best effort: a missing object must never block deleting the row that
   pointed at it. */
export async function removeImage(path) {
  if (!path) return;
  const { error } = await supabase.storage.from(BUCKET).remove([path]);
  if (error) console.error('[storage] remove failed:', path, error.message);
}

export async function signedUrl(path, seconds = 3600) {
  if (!path) return null;
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(path, seconds);
  if (error) {
    console.error('[storage] sign failed:', path, error.message);
    return null;
  }
  return data?.signedUrl || null;
}

/* One round trip for a whole catalog rather than one per picture. */
export async function signedUrlMap(paths, seconds = 3600) {
  const unique = [...new Set(paths.filter(Boolean))];
  if (!unique.length) return {};

  const { data, error } = await supabase.storage
    .from(BUCKET).createSignedUrls(unique, seconds);
  if (error) {
    console.error('[storage] batch sign failed:', error.message);
    return {};
  }

  const out = {};
  for (const row of data || []) {
    if (row.signedUrl && !row.error) out[row.path] = row.signedUrl;
  }
  return out;
}
