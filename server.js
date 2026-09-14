import 'dotenv/config';
import express from 'express';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { authRouter } from './src/routes/auth.js';
import { adminRouter } from './src/routes/admin.js';
import { appRouter } from './src/routes/app.js';
import { telegramRouter } from './src/routes/telegram.js';
import { filesRouter } from './src/routes/files.js';
import { pool } from './src/lib/db.js';
import { migrate } from './src/lib/migrate.js';
import { startScheduler, stopScheduler } from './src/lib/scheduler.js';
import { importIfEmpty } from './src/lib/supabaseImport.js';
import { ensureInitialAdmin } from './src/lib/initialAdmin.js';

if (!process.env.JWT_SECRET) {
  console.warn('[server] JWT_SECRET is not set — sessions are signed with an insecure default. Is .env next to docker-compose.yml?');
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

// Docker's healthcheck: the server is only healthy if it can reach the database
app.get('/healthz', async (req, res) => {
  try {
    await pool.query('select 1');
    res.json({ ok: true, ts: Date.now() });
  } catch {
    res.status(503).json({ ok: false, error: 'database unreachable' });
  }
});

app.use('/api/auth', authRouter);
app.use('/api/admin', adminRouter);
app.use('/api/app', appRouter);
app.use('/api/telegram', telegramRouter);
app.use('/files', filesRouter);

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public/admin/index.html')));
app.get('/', (req, res) => res.redirect('/app/'));

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

// the schema has to be in place before the first request or tick reads it
try {
  await migrate();
} catch (e) {
  console.error('[db] migration failed:', e.message);
  process.exit(1);
}

const port = process.env.PORT || 3000;
const server = app.listen(port, () => console.log(`[server] listening on :${port}`));
startScheduler();

// A new, empty database has nobody to sign in with. With the Supabase keys in
// .env it loads by itself; after an error it stays empty and tries again at
// the next start. Then ADMIN_CHAT_ID / ADMIN_PASSWORD make sure of an admin.
(async () => {
  try {
    await importIfEmpty();
  } catch (e) {
    return console.error('[import] startup load failed:', e.message);
  }
  await ensureInitialAdmin().catch((e) => console.error('[admin] initial admin failed:', e.message));
})();

// `docker compose stop` sends SIGTERM: finish what is in flight, then let go
// of the database, well inside Docker's ten seconds
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => {
    console.log(`[server] ${signal} — shutting down`);
    stopScheduler();
    server.close(() => pool.end().finally(() => process.exit(0)));
    setTimeout(() => process.exit(0), 8000).unref();
  });
}
