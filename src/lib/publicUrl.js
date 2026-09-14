import { db } from './db.js';

/* The address the server is reachable at from the internet: where Telegram
   delivers the webhook, and what the «Открыть в админ-панели» buttons in the
   operators' group link to.

   It used to be PUBLIC_URL on Render. A self-hosted server gets its address
   from a reverse proxy, and that address can change, so it is set in the
   panel (Настройки → Адрес сервера) and kept in app_settings under 'server'. */

const TTL_MS = 30_000;
let cached = null;

export async function publicUrl() {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.value;

  const { data, error } = await db
    .from('app_settings').select('value').eq('key', 'server').maybeSingle();
  if (error) {
    console.error('[settings] public url unreadable:', error.message);
    return cached?.value || '';
  }

  const value = normaliseUrl(data?.value?.public_url) || '';
  cached = { value, at: Date.now() };
  return value;
}

export const forgetPublicUrl = () => { cached = null; };

/* '' for "not set", null for something that is not a usable address.
   https only: Telegram delivers webhooks and opens mini-apps over nothing
   else. */
export function normaliseUrl(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return '';

  let url;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.search || url.hash || url.username) return null;
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}
