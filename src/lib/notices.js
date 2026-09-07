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
  if (!user.user_code) return '⚠️ <b>Доступ открыт, код не назначен</b>';
  return `✅ <b>Доступ открыт</b> · код: <code>${esc(user.user_code)}</code>`;
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

  await editMessageText(group, user.notice_message_id, noticeText(user, opts), {
    reply_markup: markup(user, opts)
  });
}
