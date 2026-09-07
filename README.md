# Good Food — order system (stage 1 carcass)

Static HTML/CSS/JS served by a small Express app. Supabase for the DB, Render
for hosting, Telegram bot + mini-app on top (bot is a stub at this stage).

## Layout

```
server.js              Express: static files + API + telegram webhook
db/schema.sql          full schema; db/migrations/ for an existing database
src/lib/               supabase, JWT cookie auth, telegram client, notices
src/routes/            auth.js, admin.js, app.js (mini-app API), telegram.js
public/admin/          admin panel (nav + content)
public/app/            Telegram mini-app
```

## Admin panel

Three blocks: left nav (300px) · main content · right accessibility panel (300px).

- Nav: Заказы, Позиции, Пользователи, Настройки, Сообщения, Cron
- Theme (light/dark) and the compact toggle sit at the bottom of the nav.
- Preferences persist in `localStorage` and sync to `public.admin_prefs`.
- Working today: **Заказы** (confirm/reject), **Позиции** (items, categories,
  materials), **Пользователи** (users + companies), **Настройки**.
  Сообщения and Cron are still placeholders.

Login: **chat_id + access code** of a `public.users` row with `role = 'admin'`
→ signed httpOnly cookie (12h). Both must match the same row. Owner codes are
rejected here, admin codes are rejected by the mini-app.

## Company users

Two separate credentials:

There is exactly one code in the system: **the company code**. Nobody has a
personal code.

- **Admins** — `role = 'admin'`, sign in at `/admin` with their `chat_id` +
  their own company's code. The API refuses to save an admin without both, and
  refuses to delete or demote the last enabled admin.
- **Company staff** — `owner` or `employee`. Inside Telegram the mini-app
  identifies them from the signed launch payload and no code is typed at all;
  in a plain browser they enter `chat_id` + the company code.

A company code alone gets nobody in: the user must already exist (via `/start`)
and have been approved by an admin. The first person to join a company becomes
its `owner`; everyone after is an `employee`. One owner per company, enforced
by a partial unique index.

## Orders

The mini-app has two modes over one catalog — **Заказ** and **Возврат** —
which differ only by `orders.kind`. Customers see items and prices; materials
and their costs are never sent to the client. Grouping by category follows the
app setting.

Baskets are priced **server-side**: the browser sends item ids and quantities
only, and `orders.items` stores a priced snapshot so history stays truthful
after the catalog changes.

A new order posts to the admin group with a button into the panel. Confirming
or rejecting it in **Заказы** rewrites that post in place and messages the
person who ordered — plus the company owner, if
**Настройки → Уведомления о заказах** is set to «Заказчика и владельца».
Deciding an order twice is refused rather than re-notifying everyone.

The mini-app exchanges the code for a 30-day cookie and stamps `last_login`.

### Editing, repeating and cancelling

Any order can be **repeated**: its lines drop into the basket for the customer
to look over and send as a new order. A repeat is a new document, not a copy —
it is priced from today's catalog and approved on its own.

An order nobody has approved yet is **freely editable**. **Настройки →
Изменение заказов** can put one daily cutoff on that:

- **Заказы закрываются в** — `HH:MM` local (`Europe/Chisinau`). Past it the
  day's orders have gone into production and are closed to the customer.
- **Заказы после этого времени** — either accepted **for the next day** (they
  stay editable until *tomorrow's* cutoff) or **not accepted** until
  **Приём открывается снова в** the following morning.
- **Отмена неподтверждённых заказов** — whether the author may cancel their
  own order while it is still `new`.

`orders.service_date` records the day an order counts for, stamped at insert so
moving the cutoff later never rewrites history.

The rules live in `src/lib/orders.js` and both sides read them from there: the
mini-app to decide what to draw, the `POST`/`PATCH`/`DELETE` endpoints to
decide what to accept. An app left open since before the cutoff is refused
exactly like one opened after it, and its buttons drop away on their own when
the deadline passes.

An edit re-prices the basket and posts a **new** message to the admin group —
the old post is blanked to a pointer, since somebody may already have started
on those numbers. A cancellation marks the old post instead of removing it.

Apply `db/migrations/order_edit_cutoff.sql` before deploying this.

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
