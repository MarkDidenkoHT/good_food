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

Login: `ADMIN_USERNAME` / `ADMIN_PASSWORD` → signed httpOnly cookie (12h).

## Company users

Created in the admin panel; each gets a short code (no 0/O/1/I) and a role:

- `owner` (default) — the companies that will use the Telegram mini-app.
- `admin` — reserved for admin-panel operators; blocked from the mini-app login.

The mini-app exchanges the code for a 30-day cookie and stamps `last_login`.

## Local run

```bash
npm install
cp .env.example .env   # fill in Supabase + admin creds
npm run dev
```

Admin: http://localhost:3000/admin · mini-app: http://localhost:3000/app/

## Render

Web Service · Build `npm install` · Start `npm start` · Health check `/healthz`.
Env vars are listed in `.env.example`.
