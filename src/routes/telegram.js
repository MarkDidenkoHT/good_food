import { Router } from 'express';
import { supabase } from '../lib/supabase.js';
import { sendMessage, esc } from '../lib/telegram.js';
import { sendNewUserNotice } from '../lib/notices.js';

export const telegramRouter = Router();

/* Bot webhook. Telegram retries anything that is not a 2xx, and a retry storm
   is worse than a dropped update, so every path answers 200 and problems are
   logged rather than surfaced. */

telegramRouter.post('/webhook', async (req, res) => {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (secret && req.get('x-telegram-bot-api-secret-token') !== secret) {
    return res.sendStatus(401);
  }

  // Answer first: handling runs after, so a slow DB never causes a retry.
  res.sendStatus(200);

  try {
    await handleUpdate(req.body || {});
  } catch (err) {
    console.error('[telegram] update failed:', err);
  }
});

async function handleUpdate(update) {
  const msg = update.message || update.edited_message;
  if (!msg?.text) return;

  const chat = msg.chat || {};
  const text = msg.text.trim();
  const cmd = text.split(/[\s@]/)[0];

  // Every chat the bot is in shows up here, so this is how you read a group
  // id off the Render logs. getUpdates cannot be used once a webhook is set.
  console.log(`[telegram] ${chat.type} chat_id=${chat.id} text=${text.slice(0, 40)}`);

  // /id works anywhere — the way to get a group id without getUpdates.
  // Group privacy mode hides normal messages from bots but never commands.
  if (cmd === '/id') {
    await sendMessage(chat.id,
      `chat_id: <code>${chat.id}</code>\nтип: ${chat.type}`);
    return;
  }

  // Only private chats register users.
  if (chat.type !== 'private') return;

  if (cmd === '/start') await onStart(msg);
}

async function onStart(msg) {
  const chatId = msg.chat.id;
  const from = msg.from || {};
  const displayName =
    [from.first_name, from.last_name].filter(Boolean).join(' ') ||
    from.username ||
    `chat ${chatId}`;

  const { data: existing, error: findErr } = await supabase
    .from('users').select('id, user_name, user_code, access').eq('chat_id', chatId).maybeSingle();

  if (findErr) {
    console.error('[telegram] lookup failed:', findErr);
    return;
  }

  if (existing) {
    await sendMessage(chatId, existing.access && existing.user_code
      ? `С возвращением, ${esc(existing.user_name || displayName)}! Ваш код доступа: <code>${esc(existing.user_code)}</code>`
      : 'Вы уже зарегистрированы. Доступ пока не открыт — с вами свяжется менеджер.');
    return;
  }

  // New arrival: no code, no access. An admin grants both from the panel.
  const { data: created, error } = await supabase
    .from('users')
    .insert({
      user_name: displayName,
      chat_id: chatId,
      tg_username: from.username || null,
      access: false,
      role: 'owner'
    })
    .select().single();

  if (error) {
    console.error('[telegram] insert failed:', error);
    return;
  }

  await sendMessage(chatId,
    'Здравствуйте! Заявка принята. Доступ откроет менеджер — вы получите сообщение, когда всё будет готово.');

  await sendNewUserNotice(created, from.username);
}
