import { supabase } from './supabase.js';
import { sendMessage, editMessageText, adminGroupId, esc } from './telegram.js';

/* The "new user" post in the admin group is a living status line, not a
   one-off alert: every admin action on that user rewrites it in place. The
   group therefore reads as a worklist — anything still saying "Доступ
   закрыт" needs attention. */

const panelUrl = (userId) => {
  const base = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
  return base ? `${base}/admin#users?focus=${userId}` : null;
};

function statusLine(user, { deleted = false } = {}) {
  if (deleted) return '🗑 <b>Удалён</b>';
  if (user.access === false) return '⛔️ <b>Доступ закрыт</b>';
  if (!user.company_id) return '⚠️ <b>Доступ открыт, компания не назначена</b>';
  return `✅ <b>Доступ открыт</b> · ${esc(user.company_name || 'компания назначена')}`;
}

function noticeText(user, opts = {}) {
  const when = new Date().toLocaleString('ru-RU', {
    timeZone: 'Europe/Chisinau', dateStyle: 'short', timeStyle: 'short'
  });
  return [
    '<b>Новый пользователь</b>',
    `Имя: ${esc(user.user_name || '—')}`,
    user.tg_username ? `Username: @${esc(user.tg_username)}` : null,
    `chat_id: <code>${user.chat_id}</code>`,
    '',
    statusLine(user, opts),
    `<i>обновлено ${when}</i>`
  ].filter((l) => l !== null).join('\n');
}

// A deleted user has nothing left to open in the panel.
function markup(user, { deleted = false } = {}) {
  const url = deleted ? null : panelUrl(user.id);
  if (!url) return undefined;
  return { inline_keyboard: [[{ text: '👤 Открыть в админ-панели', url }]] };
}

/* Posts the notice and remembers its message id so it can be edited later. */
export async function sendNewUserNotice(user, tgUsername) {
  const group = adminGroupId();
  if (!group) {
    console.warn('[notices] skipped — TELEGRAM_ADMIN_GROUP_ID is not set');
    return;
  }

  const withName = { ...user, tg_username: tgUsername };
  const res = await sendMessage(group, noticeText(withName), {
    reply_markup: markup(withName)
  });

  const messageId = res?.result?.message_id;
  if (!messageId) return;

  const { error } = await supabase
    .from('users').update({ notice_message_id: messageId }).eq('id', user.id);
  if (error) console.error('[notices] could not store message id:', error);
}

/* Rewrites the group post after an admin acts. Best-effort: a user created
   before this existed has no stored id, and Telegram refuses edits on
   messages older than 48h — neither is worth failing the admin request. */
export async function refreshUserNotice(user, opts = {}) {
  const group = adminGroupId();
  if (!group || !user?.notice_message_id) return;

  let company_name = null;
  if (user.company_id) {
    const { data } = await supabase
      .from('companies').select('company_name').eq('id', user.company_id).maybeSingle();
    company_name = data?.company_name || null;
  }

  const full = { ...user, company_name };
  await editMessageText(group, user.notice_message_id, noticeText(full, opts), {
    reply_markup: markup(full, opts)
  });
}


/* ── orders ───────────────────────────────────────────────────────────── */

const KIND = { order: 'Заказ', return: 'Возврат' };
const STATUS = {
  new:       '🕒 <b>Новый</b>',
  confirmed: '✅ <b>Подтверждён</b>',
  rejected:  '❌ <b>Отклонён</b>'
};

const orderUrl = (orderId) => {
  const base = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
  return base ? `${base}/admin#orders?focus=${orderId}` : null;
};

function orderLines(order) {
  return (Array.isArray(order.items) ? order.items : [])
    .map((l) => `• ${esc(l.name)} × ${l.qty} — ${l.cost * l.qty} ₽`)
    .join('\n');
}

function orderText(order, { company, user } = {}) {
  const when = new Date().toLocaleString('ru-RU', {
    timeZone: 'Europe/Chisinau', dateStyle: 'short', timeStyle: 'short'
  });
  return [
    `<b>${KIND[order.kind] || 'Заказ'} #${order.id}</b>`,
    company ? `Компания: ${esc(company.company_name || '—')}` : null,
    user ? `Заказал: ${esc(user.user_name || '—')}` : null,
    '',
    orderLines(order),
    '',
    `Итого: <b>${order.total ?? 0} ₽</b>`,
    order.comment ? `Комментарий: ${esc(order.comment)}` : null,
    '',
    STATUS[order.status] || order.status,
    `<i>обновлено ${when}</i>`
  ].filter((l) => l !== null).join('\n');
}

function orderMarkup(order) {
  const url = orderUrl(order.id);
  return url ? { inline_keyboard: [[{ text: '📋 Открыть в админ-панели', url }]] } : undefined;
}

async function orderContext(order) {
  const [company, user] = await Promise.all([
    order.company_id
      ? supabase.from('companies').select('id, company_name').eq('id', order.company_id).maybeSingle()
      : Promise.resolve({ data: null }),
    order.user_id
      ? supabase.from('users').select('id, user_name, chat_id').eq('id', order.user_id).maybeSingle()
      : Promise.resolve({ data: null })
  ]);
  return { company: company.data, user: user.data };
}

export async function sendNewOrderNotice(order) {
  const group = adminGroupId();
  if (!group) {
    console.warn('[notices] order notice skipped — TELEGRAM_ADMIN_GROUP_ID is not set');
    return;
  }

  const ctx = await orderContext(order);
  const res = await sendMessage(group, orderText(order, ctx), { reply_markup: orderMarkup(order) });

  const messageId = res?.result?.message_id;
  if (!messageId) return;

  const { error } = await supabase
    .from('orders').update({ notice_message_id: messageId }).eq('id', order.id);
  if (error) console.error('[notices] could not store order message id:', error);
}

/* Called after an admin decides an order: rewrites the group post, then tells
   the person who ordered and — if the setting is on — the company owner. */
export async function announceOrderDecision(order) {
  const ctx = await orderContext(order);

  if (adminGroupId() && order.notice_message_id) {
    await editMessageText(adminGroupId(), order.notice_message_id,
      orderText(order, ctx), { reply_markup: orderMarkup(order) });
  }

  const word = order.status === 'confirmed' ? 'подтверждён' : 'отклонён';
  const text = [
    `<b>${KIND[order.kind] || 'Заказ'} #${order.id} ${word}</b>`,
    '',
    orderLines(order),
    '',
    `Итого: <b>${order.total ?? 0} ₽</b>`
  ].join('\n');

  const targets = new Set();
  if (ctx.user?.chat_id) targets.add(String(ctx.user.chat_id));

  if (await notifyOwnerEnabled()) {
    const { data: owner } = await supabase
      .from('users').select('chat_id')
      .eq('company_id', order.company_id).eq('role', 'owner').maybeSingle();
    // a Set keyed by chat id means the owner who placed the order is not
    // messaged twice
    if (owner?.chat_id) targets.add(String(owner.chat_id));
  }

  for (const chatId of targets) await sendMessage(chatId, text);
}

async function notifyOwnerEnabled() {
  const { data } = await supabase
    .from('app_settings').select('value').eq('key', 'notifications').maybeSingle();
  // default on: the owner is the one accountable for the company's spend
  return data?.value?.notify_owner !== false;
}
