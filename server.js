import 'dotenv/config';
import express from 'express';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { authRouter } from './src/routes/auth.js';
import { adminRouter } from './src/routes/admin.js';
import { appRouter } from './src/routes/app.js';
import { telegramRouter } from './src/routes/telegram.js';
import { cronRouter } from './src/routes/cron.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

app.get('/healthz', (req, res) => res.json({ ok: true, ts: Date.now() }));

app.use('/api/auth', authRouter);
app.use('/api/admin', adminRouter);
app.use('/api/app', appRouter);
app.use('/api/telegram', telegramRouter);
app.use('/api/cron', cronRouter);

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public/admin/index.html')));
app.get('/', (req, res) => res.redirect('/app/'));

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`[server] listening on :${port}`));
