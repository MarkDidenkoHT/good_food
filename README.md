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

- Nav: Заказы, Позиции, Пользователи, Настройки, Сообщения, Напоминания
- Theme (light/dark) and the compact toggle sit at the bottom of the nav.
- Preferences persist in `localStorage` and sync to `public.admin_prefs`.
- Working today: **Заказы** (confirm/reject), **Позиции** (items, categories,
  materials), **Пользователи** (users + companies), **Настройки**,
  **Сообщения** (broadcasts), **Напоминания** (scheduled messages).

### Напоминания

Recurring bot messages on a weekly timetable. An admin fills in a name, the
weekdays, a time, the text and who gets it — the word *cron* appears nowhere in
the product, and no cron expression is ever typed.

Supabase keeps the clock, the server does the sending:

1. Run `db/migrations/011_reminders.sql` and `012_reminder_runs.sql` in the
   Supabase SQL editor.
2. Set `CRON_SECRET` in the environment (`openssl rand -hex 32`).
3. Fill the service URL and the same secret into `db/cron_setup.sql` and run
   it. `pg_cron` then calls `POST /api/cron/tick` every five minutes, and that
   endpoint sends whatever is due.

Consequences of the five-minute tick worth knowing:

- A reminder set for 16:02 goes out at 16:05 — times are honoured to five
  minutes, and the panel says so.
- The time is a wall clock in `Europe/Chisinau`, so it survives DST.
- A reminder that comes due more than an hour late is skipped rather than sent
  — a server that was down over lunch does not deliver a lunchtime reminder in
  the evening.
- Every attempt writes a row in `reminder_runs` — one per reminder per day —
  and that row is also the claim on the day, so overlapping ticks cannot send
  twice. Because it records the *outcome* and not just the attempt, a send
  that failed at 16:00 is retried at 16:05 (up to 3 attempts, within the same
  hour-long grace window) instead of being lost until tomorrow. The panel
  shows these rows under **История**.
- A fired reminder becomes an ordinary broadcast, so it appears in
  **Сообщения** with its delivery counters and can be recalled like any other
  message. «Отправить сейчас» in the panel sends the same thing by hand
  without consuming the day's scheduled send.

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
and be approved by an admin before they get a session. Nobody is promoted for
being early — every new arrival is an `employee`, and an admin names the owner.
One owner per company, enforced by a partial unique index.

### Registering is code-first

The code is what ties a person to a company, so it is asked for *before* the
approval rather than after it:

1. `/start` creates the row and replies asking for the company code. Nothing
   is posted to the operators' group — pressing Start only says that somebody
   found the bot, which is not something an operator can act on.
2. The person enters the code in the mini-app. That attaches them to the
   company and posts **«Новый пользователь · Компания ACME»** to the group —
   a request naming its company, which *is* actionable.
3. An admin opens access. Only then is a session issued.

An unapproved user may therefore enter a code; they still leave without a
session (`403 pending`). A leaked code buys nothing but a pending row.

### Reissuing the code locks the company down

The code does not stop mattering once it has been typed. Every company carries
a `code_version`, every user carries the version they last entered, and the two
must match or the user is **stale** — still on the roster, still approved,
still holding their history, but unable to order until somebody gives them the
current code.

Reissuing is therefore one write against one row that stops an entire company
at once, and each person comes back individually as the code is passed around.
That asymmetry is the point: blocking is instant and wholesale, restoring is
deliberate and one at a time. It is the fast answer to "somebody in that
company should not be ordering any more, and we will sort out who later".

- **Пользователи → Компании → Изменить → Перевыпустить.** The code is
  otherwise read-only: a mass lockout must not fall out of a typo in a form.
  The confirmation names how many people it will stop.
- Everyone affected gets a Telegram message saying access is suspended and to
  ask whoever runs their company — deliberately **without** the new code, which
  would undo the lockout in the same breath. The new code goes to the
  operators' group.
- Sessions are a 30-day JWT, so the check cannot live at sign-in alone:
  `requireFreshCode` guards every mini-app endpoint, reading the version from
  a 30-second cache that the rotation itself refreshes.
- `companies.access = false` remains the blunt version — everybody out, nobody
  back.

**Настройки → Пароль компании** decides who may press it. By default only an
admin; switched on (`app_settings.auth.allow_owner_reset`), a company owner
can also do it from inside the mini-app, in which case the new code goes to
the owner and to the operators' group. The owner stays signed in — they are
standing in the app and they are the one who has to hand the code out.

Run [db/migrations/company_code_rotation.sql](db/migrations/company_code_rotation.sql)
in the Supabase SQL editor. It stamps everyone already inside with their
company's current version, so applying it evicts nobody.

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

## Returns out of the order history

Настройки → «Оформление возврата» has two modes.

**Из каталога** (default) — a return is composed like an order: pick from the
catalogue on the Возврат tab.

**Только из истории заказов** — the Возврат tab disappears. The customer opens
a past order in История and presses «Вернуть», which lists that order's own
lines with a stepper capped at what is still returnable.

What is still returnable is the ordered quantity **less everything already
sent back against that same order**, so a portion cannot be returned twice
across several attempts; a rejected return frees its quantity again. Lines are
priced from the order's own snapshot rather than today's catalogue — the
customer is sending back what they bought, at what they were charged.

`orders.source_order_id` records which order a return came out of. The cap is
enforced in `POST /api/app/orders`, not just in the picker: an over-quantity
request answers **409**, an unknown or foreign order **404**, and a return of
something that order never contained **400**. Apply
`db/migrations/010_return_source.sql`.

## Withdrawing an item

`items.available` takes a position off the order list without deleting it.
Deleting would break the record: order lines keep their own priced snapshot,
but the catalogue is also what a **return** is picked from, so something no
longer sold must still be selectable to send back.

`false` therefore stops exactly one thing — placing a *new* order:

- **Заказ** tab hides it; **Возврат** tab still lists it
- history is unaffected — those lines are snapshots
- `POST /api/app/orders` and `PATCH /api/app/orders/:id` re-check on the way
  in and answer **409** naming the item, so a basket filled before the switch
  cannot slip through; the mini-app then re-reads the catalogue and drops the
  item from the order basket
- «Повторить» on an old order skips withdrawn lines

Toggle it from the row pill in **Позиции** (one click, no dialog — it is
reversible) or from the item form. Apply `db/migrations/009_item_available.sql`.

## Chat ID is a credential

`chat_id` is not a contact detail — it is the identity half of the login.
`POST /api/auth/*` resolves **who you are** from `chat_id` alone; the company
code only proves **which company**. Pointing an established row at another
Telegram account therefore hands that account over, `role: 'admin'` rows
included.

It cannot simply be made read-only: [admin.js](src/routes/admin.js) *requires*
a `chat_id` when creating an admin, because admins are pre-created before they
ever press `/start`. So the rule is about *re*-binding, not editing:

- `last_login IS NOT NULL` is the test for "established" — it means someone
  actually signed in with this id. A hand-typed id may never have been used;
  `chat_id` being merely present proves nothing.
- Changing or clearing such an id answers **409 `chat_id_locked`** unless the
  request carries `chat_id_rebind: true`, which the panel sends only after the
  admin types the user's name back.
- Every rebind is posted to the operators' group with the old id, the new one,
  and which admin did it.

The notification is the part that matters. A panel-side lock is **not** a
security boundary — an admin can call the API directly — so the goal is that a
rebind cannot happen by accident or *quietly*. Admins remain trusted; this
makes the one edit that transfers an account visible after the fact.

Two smaller guards sit alongside it. `toChatId` used to return `null` for
anything non-numeric, so a typo like `312 756 470` silently **cleared** the
field and locked the user out under a success toast — malformed input is a
400 now, and only a genuinely empty value means "no chat id". And the
`users_chat_id_key` collision answers 409 with a readable message instead of
raw Postgres text.

## FrontPad

A port of the old Google Sheets script: when an admin confirms an order,
`POST /orders/:id/decide` calls `pushOrder()` in `src/lib/frontpad.js`
**before** changing the status. If FrontPad refuses, the order stays «Новый»
and the admin sees the reason in the dialog — as the old «Завершить» did.

Request: `POST https://app.frontpad.ru/api/index.php?new_order`,
form-urlencoded — `secret`, `name` (company), `descr` (`Company #id — comment`),
`datetime` (service day + 1 at `delivery_time`), `phone` (company phone, only
if filled), `product[i]` / `product_kol[i]`.

### Settings (Настройки → FrontPad, `app_settings.frontpad`)

| key | default | meaning |
|---|---|---|
| `enabled` | false | send at all |
| `simulation` | **true** | build and log everything, send nothing |
| `verbose` | true | full trail in Render logs (article map, every line) |
| `send_returns` | false | send returns with `items.frontpad_return_id` |
| `delivery_time` | 10:00 | time part of FrontPad `datetime` |

Switching to «Боевой» asks for confirmation. **Проверить связь** calls
`get_products` and lists our articles FrontPad does not know.

### Tracking

Each order carries `frontpad_status` (`none | simulated | sent | failed`),
`frontpad_order_id`, `frontpad_order_number`, `frontpad_error`,
`frontpad_sent_at`. A `sent` order is never sent again; a confirmed order in
any other state gets an «В FrontPad» button (`POST /orders/:id/frontpad`).
Every attempt — simulated or real, without the key — lands in
`frontpad_log`, shown under the settings card.

### What it refuses to do

- **Returns are not sent** unless `send_returns` is on.
- **An order with an unmapped position is not sent at all** (in simulation
  too — that is what simulation is for). It names the positions.
- No key in live mode → refused with a message.

### The mapping

Every catalogue position carries a **`frontpad_id`** — its article in
FrontPad. It is text, not a number: FrontPad articles are free-form and may
have leading zeros, which a numeric column would eat. A unique index enforces
one article per position, because two items sharing an article would collapse
into a single line in FrontPad and lose a sale; the API turns that collision
into a readable message rather than raw Postgres text.

Edit it in the item form (**Артикул FrontPad**); the **Позиции** table shows
it as a column and marks the positions still missing one, since those are the
ones that would block an order from being pushed. The item search matches the
article as well as the name.

`FRONTPAD_APIKEY` is read from the environment (set on Render). It authorises
order creation, so it is server-only and must never reach the browser.

Apply `db/migrations/013_frontpad.sql` and `014_frontpad_send.sql` before
deploying this.

## Broadcasts (Сообщения)

An admin composes one message — up to **1000 characters**, optionally with a
single photo — and picks who gets it: everyone, whole companies, or named
people. Only users with an open access flag who have started the bot are
recipients; the panel shows the count before anything is sent.

Two tables back it. `broadcasts` holds what was composed and the counters;
`broadcast_targets` holds one row per recipient carrying **that user's own
Telegram `message_id`**. That id is the only handle Telegram gives for taking
a message back out of a chat, so it has to be stored per user — which is what
makes **«Удалить сообщение из чатов»** possible after the fact.

Delivery is detached from the request: the recipient list is fixed and written
down before the route answers, then `src/lib/broadcasts.js` sends at ~25/s and
updates the counters as it goes; the panel polls while anything is in flight.
One blocked chat is recorded against that recipient and the run continues.
Recall behaves the same way — Telegram refusing to delete one copy (chat
cleared, bot blocked, message too old) leaves that row marked and moves on.

The photo lives in the `item_images` bucket under `broadcasts/`; the bucket is
private, so the send hands Telegram a short-lived signed URL to fetch. The
1000-character cap sits under Telegram's 1024-character caption limit, so the
same text works with and without a picture.

Apply `db/migrations/008_broadcasts.sql` before deploying this.

## Telegram bot

`src/lib/telegram.js` is a fetch wrapper over the Bot API; `src/routes/telegram.js`
is the webhook.

On `/start` in a private chat the bot looks the sender up by `chat_id`. If they
are new it inserts a row with **no company, `access = false`, `role = employee`**
and replies asking for the company code. Nothing goes to the operators' group
yet: the group hears about them when they enter the code, because that is the
first moment there is a company to name (see *Registering is code-first*).

A returning user is told whichever of the three things is true of them — enter
a code, wait for approval, or go ahead and order — in that order, so somebody
who has not entered a code yet is never told to sit and wait for a manager who
has not been told anything about them.

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
