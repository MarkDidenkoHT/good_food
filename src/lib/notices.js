import { supabase } from './supabase.js';
import { sendMessage, editMessageText, adminGroupId, esc } from './telegram.js';

/* The "new user" post in the admin group is a living status line, not a
   one-off alert: every admin action on that user rewrites it in place. The
   group therefore reads as a worklist — anything still saying "Доступ
   закрыт" needs attention.

   It goes up when the person enters their company code, not when they press
   /start. Pressing /start says only that somebody found the bot; entering
   the code is the first moment there is a company to name, and a request
   naming its company is the one an operator can actually act on. */

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
    user.company_name ? `Компания: <b>${esc(user.company_name)}</b>` : null,
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
export async function sendNewUserNotice(user, companyName = null) {
  const group = adminGroupId();
  if (!group) {
    console.warn('[notices] skipped — TELEGRAM_ADMIN_GROUP_ID is not set');
    return;
  }

  const full = { ...user, company_name: companyName ?? user.company_name ?? null };
  const res = await sendMessage(group, noticeText(full), {
    reply_markup: markup(full)
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


/* ── company code ─────────────────────────────────────────────────────── */

// Telegram tolerates far more than this; the pause is here so a company of a
// hundred does not arrive as one burst.
const GAP_MS = 40;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/* Says what a reissued code means to each audience.

   The operators' group gets the new code, because a manager is who people
   ring when they are locked out. Everyone who was using the old one gets a
   sentence explaining why the app stopped — and deliberately not the code
   itself: sending it back automatically would undo the lockout in the same
   breath as it began. Whoever the code is for, a person passes it on. */
export async function announceCodeRotated({ company, code, actorName, suspended = [], keeper = null }) {
  const name = esc(company.company_name || `#${company.id}`);

  const group = adminGroupId();
  if (group) {
    await sendMessage(group, [
      '🔑 <b>Код компании перевыпущен</b>',
      `Компания: <b>${name}</b>`,
      `Кто: ${esc(actorName || 'админ')}`,
      '',
      `Новый код: <code>${esc(code)}</code>`,
      '',
      suspended.length
        ? `Доступ приостановлен у ${suspended.length} чел. — вернутся, когда введут новый код.`
        : 'В компании некого было отключать.'
    ].join('\n'));
  } else {
    console.warn('[notices] rotation notice skipped — TELEGRAM_ADMIN_GROUP_ID is not set');
  }

  /* The owner who pressed the button: still standing in the app, and the one
     who now has to hand the code out. */
  if (keeper?.chat_id) {
    await sendMessage(keeper.chat_id, [
      '🔑 <b>Код компании перевыпущен</b>',
      '',
      `Новый код: <code>${esc(code)}</code>`,
      '',
      'Сотрудники отключены от приложения. Передайте код тем, кто должен ' +
      'сохранить доступ — остальные войти не смогут.'
    ].join('\n'));
  }

  for (const user of suspended) {
    await sendMessage(user.chat_id,
      '⛔️ <b>Доступ приостановлен</b>\n\n' +
      'Код компании изменён. Запросите новый код у руководителя ' +
      'и введите его в приложении.');
    await pause(GAP_MS);
  }
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

/* An edited order gets its own post rather than a quiet rewrite of the old
   one: the group is a worklist read top to bottom, and a change to an order
   somebody may already be preparing has to arrive as a new line in it. The
   old post is blanked to a pointer so nobody works from stale numbers, and
   the new post becomes the one a decision later rewrites. */
export async function sendOrderEditedNotice(order) {
  const group = adminGroupId();
  if (!group) return;

  const ctx = await orderContext(order);

  // The old post's numbers are no longer what anyone should work from; it is
  // replaced by a pointer rather than by the new figures, which get their own
  // message below.
  if (order.notice_message_id) {
    await editMessageText(group, order.notice_message_id,
      `<b>${KIND[order.kind] || 'Заказ'} #${order.id}</b>

` +
      '✏️ <i>Заказ изменён пользователем — актуальный состав в сообщении ниже.</i>');
  }

  const text = `✏️ <b>Заказ изменён</b>

${orderText(order, ctx)}`;
  const res = await sendMessage(group, text, { reply_markup: orderMarkup(order) });

  const messageId = res?.result?.message_id;
  if (!messageId) return;

  const { error } = await supabase
    .from('orders').update({ notice_message_id: messageId }).eq('id', order.id);
  if (error) console.error('[notices] could not store order message id:', error);
}

/* The order row is gone, so there is nothing left to open in the panel: the
   post stays as a record of what was asked for, marked as withdrawn. */
export async function markOrderDeleted(order) {
  const group = adminGroupId();
  if (!group || !order?.notice_message_id) return;

  const ctx = await orderContext(order);
  await editMessageText(group, order.notice_message_id,
    `${orderText(order, ctx)}

🗑 <b>Заказ отменён пользователем</b>`);
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
