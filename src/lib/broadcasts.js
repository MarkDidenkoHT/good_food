import { supabase } from './supabase.js';
import { sendMessage, sendPhoto, deleteMessage, esc } from './telegram.js';
import { signedUrl } from './storage.js';

/* Sending a broadcast and taking it back.

   A broadcast is composed once and delivered many times, so the send loop
   writes a row per recipient carrying the Telegram message id of that user's
   own copy. That id is the only handle Telegram gives for removing a message
   from a chat afterwards; without it a sent broadcast would be permanent.

   Delivery runs detached from the HTTP request that started it: a hundred
   recipients at Telegram's rate is slower than any request should be, so the
   route answers as soon as the recipient list is fixed and the panel watches
   the counters climb. */

// Telegram tolerates ~30 messages a second to different chats; a small pause
// between sends keeps a large broadcast well underneath that.
const GAP_MS = 40;

// Captions on a photo are limited to 1024 characters by Telegram. The cap
// below is the one the panel enforces and the API re-checks.
export const MAX_TEXT = 1000;

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── audience ──────────────────────────────────────────────────────────
   Who a broadcast goes to. Only users the bot can actually reach and who
   still have access: a blocked account is not a silent failure to explain
   later, it is simply not a recipient. */
export async function resolveAudience(audience = {}) {
  // the kitchen group is not people: anything that would message users gets
  // nobody, rather than falling through to "all"
  if (audience.mode === 'kitchen') return [];

  let query = supabase
    .from('users')
    .select('id, user_name, chat_id, company_id')
    .not('chat_id', 'is', null)
    .neq('access', false)
    .order('id');

  if (audience.mode === 'companies') {
    const ids = (audience.company_ids || []).map(Number).filter(Boolean);
    if (!ids.length) return [];
    query = query.in('company_id', ids);
  } else if (audience.mode === 'users') {
    const ids = (audience.user_ids || []).map(Number).filter(Boolean);
    if (!ids.length) return [];
    query = query.in('id', ids);
  }

  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

/* The stored shape, normalised so history renders the same way it was sent. */
export function normaliseAudience(body = {}) {
  const mode = ['companies', 'users'].includes(body.mode) ? body.mode : 'all';
  return {
    mode,
    company_ids: mode === 'companies'
      ? [...new Set((body.company_ids || []).map(Number).filter(Boolean))] : [],
    user_ids: mode === 'users'
      ? [...new Set((body.user_ids || []).map(Number).filter(Boolean))] : []
  };
}

/* ── sending ─────────────────────────────────────────────────────────── */

/* Telegram renders the caption as HTML, so whatever the admin typed is
   escaped — a stray '<' in the text must not become markup. */
const bodyText = (text) => (text ? esc(text) : '');

/* Runs after the route has answered. Every failure is recorded against the
   recipient it belongs to rather than aborting the run: one blocked chat must
   not stop the other ninety-nine. */
export async function deliver(broadcastId, text, imagePath) {
  const { data: targets, error } = await supabase
    .from('broadcast_targets')
    .select('id, chat_id')
    .eq('broadcast_id', broadcastId)
    .eq('status', 'pending')
    .order('id');
  if (error) return console.error('[broadcast] targets unreadable:', error.message);

  // One link for the whole run: Telegram fetches the picture per recipient,
  // and an hour covers a broadcast far larger than these ever get.
  const photo = imagePath ? await signedUrl(imagePath, 3600) : null;
  if (imagePath && !photo) {
    // nothing was sent, so every recipient failed for the same reason
    await supabase.from('broadcast_targets')
      .update({ status: 'failed', error: 'Не удалось подготовить изображение' })
      .eq('broadcast_id', broadcastId).eq('status', 'pending');
    await finish(broadcastId, 0, targets.length);
    return;
  }

  const caption = bodyText(text);
  let delivered = 0;
  let failed = 0;

  for (const t of targets) {
    const res = photo
      ? await sendPhoto(t.chat_id, photo, caption)
      : await sendMessage(t.chat_id, caption);

    const messageId = res?.result?.message_id || null;
    if (messageId) {
      delivered++;
      await supabase.from('broadcast_targets')
        .update({ status: 'sent', message_id: messageId, error: null })
        .eq('id', t.id);
    } else {
      failed++;
      await supabase.from('broadcast_targets')
        .update({ status: 'failed', error: res?.description || 'Telegram не принял сообщение' })
        .eq('id', t.id);
    }

    // counters climb while the panel is watching, not only at the end
    await supabase.from('broadcasts')
      .update({ delivered, failed }).eq('id', broadcastId);

    await pause(GAP_MS);
  }

  await finish(broadcastId, delivered, failed);
}

async function finish(id, delivered, failed) {
  await supabase.from('broadcasts').update({
    status: 'sent', delivered, failed, finished_at: new Date().toISOString()
  }).eq('id', id);
}

/* ── recall ──────────────────────────────────────────────────────────── */

/* Deletes every copy that was actually delivered. Telegram refuses for
   reasons nobody here can fix — the user cleared the chat, blocked the bot,
   or the message is beyond the window it allows — so a refusal marks that one
   recipient and the rest carry on. */
export async function recall(broadcastId) {
  const { data: targets, error } = await supabase
    .from('broadcast_targets')
    .select('id, chat_id, message_id')
    .eq('broadcast_id', broadcastId)
    .eq('status', 'sent')
    .not('message_id', 'is', null)
    .order('id');
  if (error) throw error;

  let removed = 0;
  let kept = 0;

  for (const t of targets || []) {
    const res = await deleteMessage(t.chat_id, t.message_id);
    if (res?.ok) {
      removed++;
      await supabase.from('broadcast_targets')
        .update({ status: 'deleted', deleted_at: new Date().toISOString(), error: null })
        .eq('id', t.id);
    } else {
      kept++;
      await supabase.from('broadcast_targets')
        .update({ error: res?.description || 'Telegram не удалил сообщение' })
        .eq('id', t.id);
    }
    await pause(GAP_MS);
  }

  await supabase.from('broadcasts').update({
    status: 'deleted', deleted_at: new Date().toISOString()
  }).eq('id', broadcastId);

  return { removed, kept };
}
