import { runDue } from './reminders.js';
import { dailyBackupIfDue } from './backups.js';

/* The clock for Уведомления and the daily backup.

   On Render the tick came from Supabase every five minutes; self-hosted, the
   server keeps the time itself. It ticks a few seconds past every five-minute
   mark, and a tick that fails is simply followed by the next one — the run
   log in reminder_runs is what makes that safe (see lib/reminders.js). */

const EVERY_MS = 5 * 60 * 1000;
const PAST_MARK_MS = 5 * 1000;

let timer = null;

async function tick() {
  try {
    const report = await runDue();
    if (report.sent.length || report.retried.length || report.skipped.length) {
      console.log('[scheduler] tick', JSON.stringify(report));
    }
  } catch (e) {
    console.error('[scheduler] tick failed:', e.message);
  }

  try {
    await dailyBackupIfDue();
  } catch (e) {
    console.error('[scheduler] daily backup failed:', e.message);
  }
}

export function startScheduler() {
  if (timer) return;
  const next = () => {
    const wait = EVERY_MS - (Date.now() % EVERY_MS) + PAST_MARK_MS;
    timer = setTimeout(async () => {
      await tick();
      if (timer) next();
    }, wait);
  };
  next();
  console.log('[scheduler] reminders tick every 5 minutes');
}

export function stopScheduler() {
  clearTimeout(timer);
  timer = null;
}
