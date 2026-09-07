import { Router } from 'express';

export const telegramRouter = Router();

// Placeholder webhook. Wired up properly in the bot stage; for now it just
// acknowledges so Telegram does not retry, and logs what arrives.
telegramRouter.post('/webhook', (req, res) => {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (secret && req.get('x-telegram-bot-api-secret-token') !== secret) {
    return res.sendStatus(401);
  }
  console.log('[telegram] update', JSON.stringify(req.body).slice(0, 500));
  res.sendStatus(200);
});
