import { db } from './db.js';

/* The Telegram account behind «Связаться с менеджером» in the mini-app. Set in
   Настройки → Связь с менеджером and kept in app_settings under 'contact',
   without the @. An empty username takes the button away. */

export const CONTACT_DEFAULTS = { manager_username: 'lovesushitrifle' };

// Telegram usernames: 5–32 latin letters, digits and underscores
const USERNAME_RE = /^[A-Za-z0-9_]{5,32}$/;

/* '' for "no button", null for something that is not a username. Takes what
   people paste: name, @name, t.me/name, https://t.me/name. */
export function normaliseUsername(raw) {
  const text = String(raw ?? '').trim()
    .replace(/^(https?:\/\/)?(www\.)?(t|telegram)\.me\//i, '')
    .replace(/^@/, '')
    .replace(/\/+$/, '');
  if (!text) return '';
  return USERNAME_RE.test(text) ? text : null;
}

export async function managerUsername() {
  const { data } = await db
    .from('app_settings').select('value').eq('key', 'contact').maybeSingle();
  const value = { ...CONTACT_DEFAULTS, ...(data?.value || {}) };
  return normaliseUsername(value.manager_username) || '';
}
