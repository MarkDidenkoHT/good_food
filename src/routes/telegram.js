import { Router } from 'express';
import { supabase } from '../lib/supabase.js';
import { notifyAdmins, sendMessage, esc } from '../lib/telegram.js';

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

  // Only private chats register users; group messages are ignored.
  if (msg.chat?.type !== 'private') return;

  const text = msg.text.trim();
  if (text === '/start' || text.startsWith('/start ')) await onStart(msg);
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
    .insert({ user_name: displayName, chat_id: chatId, access: false, role: 'owner' })
    .select().single();

  if (error) {
    console.error('[telegram] insert failed:', error);
    return;
  }

  await sendMessage(chatId,
    'Здравствуйте! Заявка принята. Доступ откроет менеджер — вы получите сообщение, когда всё будет готово.');

  await notifyAdmins(
    '<b>Новый пользователь</b>\n' +
    `Имя: ${esc(displayName)}\n` +
    (from.username ? `Username: @${esc(from.username)}\n` : '') +
    `chat_id: <code>${chatId}</code>\n` +
    `ID в базе: ${created.id}\n\n` +
    'Доступ закрыт. Откройте его и назначьте код в админ-панели.'
  );
}
