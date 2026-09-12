import { Router } from 'express';
import { supabase } from '../lib/supabase.js';
import { sendMessage, esc } from '../lib/telegram.js';

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
    .from('users').select('id, user_name, access, company_id').eq('chat_id', chatId).maybeSingle();

  if (findErr) {
    console.error('[telegram] lookup failed:', findErr);
    return;
  }

  /* The order of these matters: someone who has not entered a code yet is
     not waiting on a manager, they are waiting on themselves, and telling
     them to sit tight would strand them. */
  if (existing) {
    const name = esc(existing.user_name || displayName);
    let text;
    if (!existing.company_id) {
      text = `С возвращением, ${name}! ` +
             'Чтобы завершить регистрацию, откройте приложение и введите код компании.';
    } else if (existing.access === false) {
      text = `С возвращением, ${name}! Заявка на рассмотрении — ` +
             'вы получите сообщение, когда менеджер откроет доступ.';
    } else {
      text = `С возвращением, ${name}! Можно оформлять заказы.`;
    }
    await sendMessage(chatId, text);
    return;
  }

  /* New arrival: a row and nothing else. Pressing /start only says that
     somebody found the bot, which is not something an operator can act on —
     the operators' group hears about this person when they enter a company
     code, because that is the first moment there is a company to name. */
  const { error } = await supabase
    .from('users')
    .insert({
      user_name: displayName,
      chat_id: chatId,
      tg_username: from.username || null,
      access: false,
      role: 'employee'
    });

  if (error) {
    console.error('[telegram] insert failed:', error);
    return;
  }

  await sendMessage(chatId,
    `Здравствуйте, ${esc(displayName)}!\n\n` +
    'Чтобы зарегистрироваться, откройте приложение и введите <b>код компании</b> — ' +
    'его выдаёт ваш руководитель.\n\n' +
    'После этого заявку рассмотрит менеджер, и вы получите сообщение, ' +
    'когда доступ будет открыт.');
}
