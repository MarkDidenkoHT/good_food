import { Router } from 'express';
import { supabase, dbError } from '../lib/supabase.js';
import { requireAdmin } from '../lib/auth.js';

export const adminRouter = Router();
adminRouter.use(requireAdmin);

/* ---------- users CRUD ---------- */

adminRouter.get('/users', async (req, res) => {
  const q = String(req.query.q || '').trim();
  let query = supabase.from('users').select('*').order('id', { ascending: false });
  if (q) query = query.or(`user_name.ilike.%${q}%,user_code.ilike.%${q}%`);
  const { data, error } = await query;
  if (error) return dbError(res, error, 500);
  res.json(data);
});

adminRouter.post('/users', async (req, res) => {
  const body = pickUser(req.body);
  if (!body.user_name) return res.status(400).json({ error: 'Name required' });
  if (!body.user_code) body.user_code = randomCode();
  const { data, error } = await supabase.from('users').insert(body).select().single();
  if (error) return dbError(res, error);
  res.status(201).json(data);
});

adminRouter.patch('/users/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('users').update(pickUser(req.body)).eq('id', req.params.id).select().single();
  if (error) return dbError(res, error);
  res.json(data);
});

adminRouter.delete('/users/:id', async (req, res) => {
  const { error } = await supabase.from('users').delete().eq('id', req.params.id);
  if (error) return dbError(res, error);
  res.json({ ok: true });
});

adminRouter.get('/users/new-code', (req, res) => res.json({ code: randomCode() }));

/* ---------- admin UI prefs (right accessibility panel) ---------- */

adminRouter.get('/prefs', async (req, res) => {
  const { data, error } = await supabase
    .from('admin_prefs').select('prefs').eq('admin_key', req.admin.username).maybeSingle();
  if (error) return dbError(res, error, 500);
  res.json(data?.prefs || {});
});

adminRouter.put('/prefs', async (req, res) => {
  const { error } = await supabase.from('admin_prefs').upsert({
    admin_key: req.admin.username,
    prefs: req.body || {},
    updated_at: new Date().toISOString()
  });
  if (error) return dbError(res, error);
  res.json({ ok: true });
});

/* ---------- helpers ---------- */

function pickUser(b = {}) {
  const out = {};
  if ('user_name' in b) out.user_name = b.user_name?.trim() || null;
  if ('user_code' in b) out.user_code = b.user_code?.trim().toUpperCase() || null;
  if ('access' in b) out.access = !!b.access;
  if ('role' in b) out.role = b.role === 'admin' ? 'admin' : 'owner';
  return out;
}

// no 0/O/1/I — these codes get read off paper and typed on phones
function randomCode(len = 6) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < len; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
  return s;
}
