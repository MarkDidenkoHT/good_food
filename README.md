# Good Food — order system (stage 1 carcass)

Static HTML/CSS/JS served by a small Express app. Supabase for the DB, Render
for hosting, Telegram bot + mini-app on top (bot is a stub at this stage).

## Layout

```
server.js              Express: static files + API + telegram webhook stub
db/schema.sql          run this in the Supabase SQL editor
src/lib/               supabase client, JWT cookie auth
src/routes/            auth.js (admin + company login), admin.js (CRUD), telegram.js (stub)
public/admin/          admin panel (3-block layout)
public/app/            Telegram mini-app (code login + placeholder home)
```

## Admin panel

Three blocks: left nav (300px) · main content · right accessibility panel (300px).

- Nav: Заказы, Позиции, Пользователи, Настройки, Сообщения, Cron
- Right panel has tabs. The **Вид** tab is global (theme light/dark/system,
  compact toggles for both side panels); each page can add its own tabs — the
  Пользователи page adds a **Таблица** tab.
- Preferences persist in `localStorage` and sync to `public.admin_prefs`.
- Working today: **Пользователи** (create/edit/delete companies, generate access
  codes, toggle access). Everything else is a placeholder.

Login: **chat_id + access code** of a `public.users` row with `role = 'admin'`
→ signed httpOnly cookie (12h). Both must match the same row. Owner codes are
rejected here, admin codes are rejected by the mini-app.

## Company users

Everyone — admins and companies alike — is a row in `public.users` with a code
(no 0/O/1/I) and a role. The role decides which surface the code opens:

- `owner` (default) — the companies, 6-char code, Telegram mini-app.
- `admin` — panel operators, 10-char code, `/admin`.

Admins are created in the panel like anyone else. The **first** one has to be
inserted by `db/schema.sql` (see the bootstrap block) since the panel is what
creates users. The API refuses to delete or demote the last enabled admin.

The mini-app exchanges the code for a 30-day cookie and stamps `last_login`.

## Telegram bot

`src/lib/telegram.js` is a fetch wrapper over the Bot API; `src/routes/telegram.js`
is the webhook.

On `/start` in a private chat the bot looks the sender up by `chat_id`. If they
are new it inserts a row with **no code, `access = false`, `role = owner`**,
replies that a manager will be in touch, and posts the name, username, chat_id
and row id to `TELEGRAM_ADMIN_GROUP_ID`. An admin then opens access and assigns
a code in the panel. Returning users get their code back once access is open.

The webhook answers 200 before handling the update, so a slow database never
triggers a Telegram retry. Missing bot env vars are logged and skipped rather
than thrown, so a half-configured deploy still serves the panel.

Register the webhook once after deploying:

```bash
curl -F "url=https://YOUR-SERVICE.onrender.com/api/telegram/webhook" \
     -F "secret_token=YOUR_WEBHOOK_SECRET" \
     "https://api.telegram.org/botYOUR_BOT_TOKEN/setWebhook"
```

## Local run

```bash
npm install
cp .env.example .env   # fill in Supabase + JWT_SECRET
npm run dev
```

Admin: http://localhost:3000/admin · mini-app: http://localhost:3000/app/

## Render

Web Service · Build `npm install` · Start `npm start` · Health check `/healthz`.
Env vars are listed in `.env.example`.
