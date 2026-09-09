import { Router } from 'express';
import { runDue } from '../lib/reminders.js';

/* The only door the scheduler knocks on.

   Supabase calls this every five minutes (db/cron_setup.sql). It is not an
   admin route — there is no session behind it — so a shared secret stands in
   for one. Without CRON_SECRET set, the endpoint refuses everything rather
   than falling open: an unguarded way to make the bot message every user is
   not something to leave running by accident. */

export const cronRouter = Router();

const secret = process.env.CRON_SECRET || '';

cronRouter.post('/tick', async (req, res) => {
  if (!secret) {
    return res.status(503).json({ error: 'CRON_SECRET не задан' });
  }
  // The header is the only thing that authorises this, so compare it whole
  // and say nothing about why a wrong one failed.
  if (req.get('X-Cron-Secret') !== secret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const report = await runDue();
    res.json({ ok: true, ...report });
  } catch (e) {
    console.error('[cron] tick failed:', e.message);
    res.status(500).json({ error: 'Не удалось выполнить задание' });
  }
});
