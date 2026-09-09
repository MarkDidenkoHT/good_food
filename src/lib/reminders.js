import { supabase } from './supabase.js';
import { localNow, parseTime } from './orders.js';
import { resolveAudience, deliver, MAX_TEXT } from './broadcasts.js';
import { botConfigured } from './telegram.js';

/* Напоминания — recurring messages on a weekly timetable.

   An admin fills in a name, the weekdays, a time, the text and who gets it.
   There is no cron expression anywhere in the product: the schedule is those
   fields, and this is what reads them.

   The clock lives in Supabase (db/cron_setup.sql) and calls /api/cron/tick
   every five minutes; the sending lives here, because only the server holds
   the bot token. A fired reminder becomes an ordinary broadcast, so it
   appears in the message history with its counters and can be recalled the
   same way as anything an admin sent by hand. */

export const DAYS = [1, 2, 3, 4, 5, 6, 7];          // ISO: Monday = 1
export { MAX_TEXT };

/* How late a tick may be and still send. The ticker runs every five minutes,
   so a couple of missed ticks is nothing; an hour means the server was down,
   and a lunchtime reminder arriving at five in the evening is worse than one
   that never arrives — the admin can see it was skipped and say it again. */
const GRACE_MIN = 60;

/* ── validation, shared by the API and any future importer ─────────────── */

export function normaliseDays(value) {
  const days = [...new Set((Array.isArray(value) ? value : []).map(Number))]
    .filter((d) => DAYS.includes(d))
    .sort((a, b) => a - b);
  return days;
}

/* Returns { value } or { error } — the route turns either into a response. */
export function validate(body = {}, { partial = false } = {}) {
  const value = {};

  if (!partial || 'name' in body) {
    const name = String(body.name || '').trim();
    if (!name) return { error: 'Введите название' };
    if (name.length > 80) return { error: 'Название не длиннее 80 символов' };
    value.name = name;
  }

  if (!partial || 'days' in body) {
    const days = normaliseDays(body.days);
    if (!days.length) return { error: 'Выберите хотя бы один день недели' };
    value.days = days;
  }

  if (!partial || 'time_of_day' in body) {
    const time = parseTime(body.time_of_day);
    if (!time) return { error: 'Укажите время в формате ЧЧ:ММ' };
    value.time_of_day = time.text;
  }

  if (!partial || 'text' in body) {
    const text = String(body.text || '').trim();
    if (!text) return { error: 'Введите текст напоминания' };
    if (text.length > MAX_TEXT) return { error: `Не больше ${MAX_TEXT} символов` };
    value.text = text;
  }

  if (!partial || 'audience' in body) {
    value.audience = normaliseReminderAudience(body.audience);
  }

  if ('enabled' in body) value.enabled = !!body.enabled;

  return { value };
}

/* The broadcasts helper reads the audience off the request body itself; a
   reminder keeps it nested under `audience`, so unwrap it first. */
function normaliseReminderAudience(a = {}) {
  const mode = ['companies', 'users'].includes(a?.mode) ? a.mode : 'all';
  return {
    mode,
    company_ids: mode === 'companies'
      ? [...new Set((a.company_ids || []).map(Number).filter(Boolean))] : [],
    user_ids: mode === 'users'
      ? [...new Set((a.user_ids || []).map(Number).filter(Boolean))] : []
  };
}

export { normaliseReminderAudience as normaliseAudience };

/* ── the tick ──────────────────────────────────────────────────────────── */

/* Due means: switched on, scheduled for today's weekday, its time has passed,
   it has not already gone out today, and it is not so overdue that sending it
   would be misleading. */
export function isDue(reminder, now = localNow()) {
  if (!reminder.enabled) return false;
  if (!normaliseDays(reminder.days).includes(now.weekday)) return false;
  if (reminder.last_run_on === now.date) return false;

  const time = parseTime(reminder.time_of_day);
  if (!time) return false;

  const due = time.hh * 60 + time.mm;
  return now.minutes >= due && now.minutes - due <= GRACE_MIN;
}

/* Called by /api/cron/tick. Returns a small report rather than logging into
   the void — the tick's answer is the only place anyone can look to see
   whether the schedule is alive. */
export async function runDue(at = new Date()) {
  const now = localNow(at);
  const report = { checked: 0, sent: [], skipped: [], at: now.date, time: now.minutes };

  const { data, error } = await supabase
    .from('reminders').select('*').eq('enabled', true).order('id');
  if (error) throw error;

  const due = (data || []).filter((r) => isDue(r, now));
  report.checked = (data || []).length;
  if (!due.length) return report;

  if (!botConfigured()) {
    report.skipped = due.map((r) => ({ id: r.id, reason: 'бот не настроен' }));
    return report;
  }

  for (const reminder of due) {
    try {
      const sent = await fire(reminder, now);
      if (sent) report.sent.push({ id: reminder.id, name: reminder.name, recipients: sent });
      else report.skipped.push({ id: reminder.id, reason: 'нет получателей' });
    } catch (e) {
      console.error(`[reminders] #${reminder.id} failed:`, e.message);
      report.skipped.push({ id: reminder.id, reason: e.message });
    }
  }

  return report;
}

/* One reminder, once.

   The day is claimed BEFORE anything is sent, and only if it was not already
   claimed. Two ticks overlapping — a slow send, a retried HTTP call — then
   leave exactly one of them holding the day, and the other sends nothing.
   A run that fails after this point is a reminder missed for the day rather
   than one delivered twice, which is the right way round. */
async function fire(reminder, now) {
  const { data: claimed, error: claimErr } = await supabase
    .from('reminders')
    .update({ last_run_on: now.date, last_run_at: new Date().toISOString() })
    .eq('id', reminder.id)
    .or(`last_run_on.is.null,last_run_on.neq.${now.date}`)
    .select('id')
    .maybeSingle();
  if (claimErr) throw claimErr;
  if (!claimed) return 0;                    // another tick got there first

  const recipients = await resolveAudience(reminder.audience || {});
  if (!recipients.length) return 0;

  const { data: broadcast, error } = await supabase.from('broadcasts').insert({
    sent_by: null,
    sent_by_name: `Напоминание: ${reminder.name}`,
    text: reminder.text,
    image_path: null,
    audience: reminder.audience || {},
    reminder_id: reminder.id,
    status: 'sending',
    recipients: recipients.length
  }).select().single();
  if (error) throw error;

  const { error: tErr } = await supabase.from('broadcast_targets').insert(
    recipients.map((u) => ({
      broadcast_id: broadcast.id,
      user_id: u.id,
      user_name: u.user_name,
      company_id: u.company_id,
      chat_id: u.chat_id
    })));
  if (tErr) throw tErr;

  // Detached, exactly as a hand-sent broadcast is: the tick answers as soon
  // as the recipient list is written down.
  deliver(broadcast.id, reminder.text, null)
    .catch((e) => console.error(`[reminders] #${reminder.id} delivery failed:`, e));

  return recipients.length;
}
