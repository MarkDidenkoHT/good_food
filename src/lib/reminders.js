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
   same way as anything an admin sent by hand.

   ── why there is a run log ──────────────────────────────────────────────
   Every attempt writes a row in reminder_runs, and that row is also the claim
   on the day: the unique index on (reminder_id, run_on) means two ticks can
   race and exactly one will insert.

   Recording the outcome, rather than just the fact of an attempt, is what
   makes a tick self-healing. The 16:00 tick can fail — a Telegram hiccup, a
   dropped database connection, the clocks not agreeing to the second — and
   because the row says `failed` rather than merely existing, the 16:05 tick
   can see the 16:00 send never happened and do it. A row that says `sent` is
   left alone. Nothing is sent twice, and nothing is silently skipped. */

export const DAYS = [1, 2, 3, 4, 5, 6, 7];          // ISO: Monday = 1
export { MAX_TEXT };

/* How late a tick may be and still send. The ticker runs every five minutes,
   so a couple of missed ticks is nothing; an hour means the server was down,
   and a lunchtime reminder arriving at five in the evening is worse than one
   that never arrives — the history shows it was missed and the admin can say
   it again by hand. */
const GRACE_MIN = 60;

/* Retries within that window. Three attempts over the grace period is enough
   for anything transient; past that the failure is real and repeating it just
   fills the log with the same error. */
const MAX_ATTEMPTS = 3;

/* A run left `pending` this long was interrupted — the process died between
   claiming the day and recording the outcome. Longer than the tick interval,
   so a send still in flight is never mistaken for an abandoned one. */
const STALE_MIN = 15;

/* ── validation, shared by the API and any future importer ─────────────── */

export function normaliseDays(value) {
  return [...new Set((Array.isArray(value) ? value : []).map(Number))]
    .filter((d) => DAYS.includes(d))
    .sort((a, b) => a - b);
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
    value.audience = normaliseAudience(body.audience);
  }

  if ('enabled' in body) value.enabled = !!body.enabled;

  return { value };
}

/* The broadcasts helper reads the audience off the request body itself; a
   reminder keeps it nested under `audience`, so unwrap it first. */
export function normaliseAudience(a = {}) {
  const mode = ['companies', 'users'].includes(a?.mode) ? a.mode : 'all';
  return {
    mode,
    company_ids: mode === 'companies'
      ? [...new Set((a.company_ids || []).map(Number).filter(Boolean))] : [],
    user_ids: mode === 'users'
      ? [...new Set((a.user_ids || []).map(Number).filter(Boolean))] : []
  };
}

/* ── deciding what is due ──────────────────────────────────────────────── */

/* Due on the clock alone: switched on, scheduled for today's weekday, its
   time has passed, and it is not so overdue that sending it would mislead.
   Whether it has ALREADY been sent is a separate question, answered by the
   run log rather than by the reminder — see claim(). */
export function isDue(reminder, now = localNow()) {
  if (!reminder.enabled) return false;
  if (!normaliseDays(reminder.days).includes(now.weekday)) return false;

  const time = parseTime(reminder.time_of_day);
  if (!time) return false;

  const due = time.hh * 60 + time.mm;
  return now.minutes >= due && now.minutes - due <= GRACE_MIN;
}

/* ── the tick ──────────────────────────────────────────────────────────── */

/* Called by /api/cron/tick. Returns a small report rather than logging into
   the void — the tick's answer is the first place to look when asking whether
   the schedule is alive, and the run log is the second. */
export async function runDue(at = new Date()) {
  const now = localNow(at);
  const report = { day: now.date, sent: [], retried: [], skipped: [], checked: 0 };

  const { data, error } = await supabase
    .from('reminders').select('*').eq('enabled', true).order('id');
  if (error) throw error;

  report.checked = (data || []).length;
  const due = (data || []).filter((r) => isDue(r, now));
  if (!due.length) return report;

  if (!botConfigured()) {
    report.skipped = due.map((r) => ({ id: r.id, reason: 'бот не настроен' }));
    return report;
  }

  for (const reminder of due) {
    const run = await claim(reminder, now);
    if (!run) continue;                 // already sent today, or another tick has it

    if (run.attempts > 1) report.retried.push({ id: reminder.id, attempt: run.attempts });

    try {
      const count = await fire(reminder, run);
      if (count) report.sent.push({ id: reminder.id, name: reminder.name, recipients: count });
      else report.skipped.push({ id: reminder.id, reason: 'нет получателей' });
    } catch (e) {
      console.error(`[reminders] #${reminder.id} failed:`, e.message);
      report.skipped.push({ id: reminder.id, reason: e.message });
    }
  }

  return report;
}

/* ── the claim ─────────────────────────────────────────────────────────── */

/* Takes today's run for this reminder, or returns null if there is nothing to
   do. Three outcomes, and which one happens is decided by the database rather
   than by anything read-then-written here, so overlapping ticks are safe:

   - no row yet          → insert one. The unique index means exactly one tick
                           succeeds; the losers get null.
   - row says `sent`     → null. Today is genuinely done.
   - row says `failed`,
     or `pending` and
     abandoned           → take it over, if it has attempts left. The update
                           is conditional on the attempt count it was read
                           with, so two ticks cannot both retry the same run. */
async function claim(reminder, now) {
  const { data: inserted, error } = await supabase
    .from('reminder_runs')
    .upsert({
      reminder_id: reminder.id,
      run_on: now.date,
      scheduled_at: reminder.time_of_day,
      reminder_name: reminder.name,
      status: 'pending',
      attempts: 1,
      started_at: new Date().toISOString()
    }, { onConflict: 'reminder_id,run_on', ignoreDuplicates: true })
    .select()
    .maybeSingle();

  // A conflict is the normal case on every tick after the first — it means
  // the day is already spoken for, not that anything went wrong.
  if (error && error.code !== '23505') throw error;
  if (inserted) return inserted;

  const { data: existing, error: readErr } = await supabase
    .from('reminder_runs')
    .select('*')
    .eq('reminder_id', reminder.id)
    .eq('run_on', now.date)
    .maybeSingle();
  if (readErr) throw readErr;
  if (!existing) return null;

  if (existing.status === 'sent' || existing.status === 'skipped') return null;
  if (existing.attempts >= MAX_ATTEMPTS) return null;

  // A pending run that is still young belongs to a tick that has not finished
  // yet. Leave it alone rather than sending alongside it.
  if (existing.status === 'pending') {
    const age = (Date.now() - new Date(existing.started_at).getTime()) / 60000;
    if (age < STALE_MIN) return null;
  }

  const { data: taken, error: takeErr } = await supabase
    .from('reminder_runs')
    .update({
      status: 'pending',
      attempts: existing.attempts + 1,
      started_at: new Date().toISOString(),
      finished_at: null
    })
    .eq('id', existing.id)
    .eq('attempts', existing.attempts)      // whoever reads it first, wins
    .select()
    .maybeSingle();
  if (takeErr) throw takeErr;
  return taken || null;
}

/* ── sending ───────────────────────────────────────────────────────────── */

/* One reminder, once. Every exit writes the outcome onto the run row: this is
   the only thing that lets the next tick tell a send that worked from one
   that did not. */
async function fire(reminder, run) {
  let recipients;
  try {
    recipients = await resolveAudience(reminder.audience || {});
  } catch (e) {
    await settle(run.id, { status: 'failed', error: describe(e) });
    throw e;
  }

  // Not a failure and not worth retrying every five minutes for an hour: the
  // audience is empty, and it will still be empty at 16:05.
  if (!recipients.length) {
    await settle(run.id, { status: 'skipped', error: 'В выборке нет пользователей с Telegram' });
    return 0;
  }

  try {
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

    // The recipient list is written down, so the send has happened as far as
    // the schedule is concerned — the per-recipient outcome is the
    // broadcast's business, and the counters below follow it there.
    await settle(run.id, {
      status: 'sent',
      broadcast_id: broadcast.id,
      recipients: recipients.length
    });
    await supabase.from('reminders')
      .update({ last_run_at: new Date().toISOString() }).eq('id', reminder.id);

    // Detached, exactly as a hand-sent broadcast is: the tick answers as soon
    // as the recipient list is fixed, and the counters catch up.
    deliver(broadcast.id, reminder.text, null)
      .then(() => copyCounters(run.id, broadcast.id))
      .catch((e) => console.error(`[reminders] #${reminder.id} delivery failed:`, e));

    return recipients.length;
  } catch (e) {
    await settle(run.id, { status: 'failed', error: describe(e) });
    throw e;
  }
}

const describe = (e) => String(e?.message || e || 'Неизвестная ошибка').slice(0, 300);

async function settle(runId, patch) {
  const { error } = await supabase.from('reminder_runs')
    .update({ ...patch, finished_at: new Date().toISOString() })
    .eq('id', runId);
  // Losing the outcome is not worth failing the send over — the worst case is
  // a run that looks abandoned and is retried once more.
  if (error) console.error('[reminders] could not record run:', error.message);
}

/* Once delivery has finished, the run shows the same numbers the broadcast
   does, so the history answers "did it actually arrive" without a second
   lookup. */
async function copyCounters(runId, broadcastId) {
  const { data } = await supabase.from('broadcasts')
    .select('delivered, failed').eq('id', broadcastId).maybeSingle();
  if (!data) return;
  await supabase.from('reminder_runs')
    .update({ delivered: data.delivered || 0, failed: data.failed || 0 })
    .eq('id', runId);
}
