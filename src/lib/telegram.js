/* Thin Telegram Bot API client. No SDK — the bot only sends messages and
   answers a webhook, so a fetch wrapper is the whole surface. */

import crypto from 'node:crypto';

const API = 'https://api.telegram.org';

export const botToken = () => process.env.TELEGRAM_BOT_TOKEN || '';
export const adminGroupId = () => process.env.TELEGRAM_ADMIN_GROUP_ID || '';
export const kitchenGroupId = () => process.env.TELEGRAM_KITCHEN_GROUP_ID || '';

export function botConfigured() {
  return Boolean(botToken());
}

async function call(method, payload) {
  const token = botToken();
  if (!token) {
    console.warn(`[telegram] ${method} skipped — TELEGRAM_BOT_TOKEN is not set`);
    return null;
  }

  try {
    const res = await fetch(`${API}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!data.ok) {
      console.error(`[telegram] ${method} failed:`, data.description,
        '| payload:', JSON.stringify(payload).slice(0, 200));
    }
    return data;
  } catch (err) {
    // Telegram being unreachable must never fail the request that triggered
    // the send — every caller treats this as best-effort.
    console.error(`[telegram] ${method} error:`, err.message);
    return null;
  }
}

export function sendMessage(chatId, text, extra = {}) {
  if (!chatId) return Promise.resolve(null);
  return call('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...extra
  });
}

export function editMessageText(chatId, messageId, text, extra = {}) {
  if (!chatId || !messageId) return Promise.resolve(null);
  return call('editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...extra
  });
}

/* `photo` is a URL Telegram fetches itself — the bucket is private, so what
   goes in is a short-lived signed link. The caption limit is 1024 characters,
   which is why a broadcast's text is capped below it. */
export function sendPhoto(chatId, photo, caption = '', extra = {}) {
  if (!chatId || !photo) return Promise.resolve(null);
  return call('sendPhoto', {
    chat_id: chatId,
    photo,
    ...(caption ? { caption, parse_mode: 'HTML' } : {}),
    ...extra
  });
}

/* Recalls a message from a chat. Telegram refuses for reasons the caller can
   do nothing about — the user blocked the bot, cleared the chat, or the
   message is too old — so the result is reported, never thrown. */
export function deleteMessage(chatId, messageId) {
  if (!chatId || !messageId) return Promise.resolve(null);
  return call('deleteMessage', { chat_id: chatId, message_id: messageId });
}

/* Notify the operators' group. Silently does nothing when the group is not
   configured, so a half-configured deploy still serves users. */
export function notifyAdmins(text) {
  const group = adminGroupId();
  if (!group) {
    console.warn('[telegram] notifyAdmins skipped — TELEGRAM_ADMIN_GROUP_ID is not set');
    return Promise.resolve(null);
  }
  return sendMessage(group, text);
}

export const esc = (s) =>
  String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

/* ── Mini App initData ────────────────────────────────────────────────────
   The mini-app runs in the user's browser, so anything it claims about who
   is using it is forgeable. Telegram signs the launch payload with a key
   derived from the bot token; verifying that signature is the only way to
   trust the chat id. Never take a chat id from the client unverified. */
export function verifyInitData(initData, maxAgeSec = 86400) {
  const token = botToken();
  if (!token || !initData) return null;

  let params;
  try {
    params = new URLSearchParams(initData);
  } catch {
    return null;
  }

  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');

  const checkString = [...params.entries()]
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join('\n');

  const secret = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
  const expected = crypto.createHmac('sha256', secret).update(checkString).digest('hex');

  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(hash, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  // A valid signature is forever; the timestamp is what stops a captured
  // initData string being replayed weeks later.
  const authDate = Number(params.get('auth_date') || 0);
  if (!authDate || (Date.now() / 1000) - authDate > maxAgeSec) return null;

  try {
    const user = JSON.parse(params.get('user') || 'null');
    return user?.id ? user : null;
  } catch {
    return null;
  }
}
