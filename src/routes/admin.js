import { Router } from 'express';
import { supabase, dbError } from '../lib/supabase.js';
import { requireAdmin } from '../lib/auth.js';
import { refreshUserNotice, announceOrderDecision } from '../lib/notices.js';

export const adminRouter = Router();
adminRouter.use(requireAdmin);

/* ---------- users CRUD ---------- */

adminRouter.get('/users', async (req, res) => {
  const q = String(req.query.q || '').trim();
  let query = supabase.from('users')
    .select('*, companies(company_name)')
    .order('id', { ascending: false });
  if (q) query = query.ilike('user_name', `%${q}%`);
  const { data, error } = await query;
  if (error) return dbError(res, error, 500);
  res.json(data);
});

adminRouter.post('/users', async (req, res) => {
  const body = pickUser(req.body);
  if (!body.user_name) return res.status(400).json({ error: 'Name required' });
  // an admin logs in with chat_id + their company's code, so both are required
  if (body.role === 'admin' && !body.chat_id) {
    return res.status(400).json({ error: 'Администратору нужен chat_id для входа' });
  }
  if (body.role === 'admin' && !body.company_id) {
    return res.status(400).json({ error: 'Администратору нужна компания — её код он вводит при входе' });
  }
  const { data, error } = await supabase.from('users').insert(body).select().single();
  if (error) return dbError(res, error);
  res.status(201).json(data);
});

adminRouter.patch('/users/:id', async (req, res) => {
  const patch = pickUser(req.body);
  if (patch.role === 'admin' && 'chat_id' in patch && patch.chat_id === null) {
    return res.status(400).json({ error: 'Администратору нужен chat_id для входа' });
  }
  if (patch.role === 'admin' && 'company_id' in patch && patch.company_id === null) {
    return res.status(400).json({ error: 'Администратору нужна компания — её код он вводит при входе' });
  }
  const demoted = (patch.role && patch.role !== 'admin') || patch.access === false;
  if (demoted && await isLastAdmin(req.params.id)) {
    return res.status(409).json({ error: 'Нельзя снять права у последнего администратора' });
  }
  const { data, error } = await supabase
    .from('users').update(patch).eq('id', req.params.id).select().single();
  if (error) return dbError(res, error);

  // the group post is the operators' worklist — keep it current
  refreshUserNotice(data).catch((e) => console.error('[notices]', e));
  res.json(data);
});

adminRouter.delete('/users/:id', async (req, res) => {
  if (await isLastAdmin(req.params.id)) {
    return res.status(409).json({ error: 'Нельзя удалить последнего администратора' });
  }
  const { data: gone } = await supabase
    .from('users').select('*').eq('id', req.params.id).maybeSingle();

  const { error } = await supabase.from('users').delete().eq('id', req.params.id);
  if (error) return dbError(res, error);

  if (gone) refreshUserNotice(gone, { deleted: true }).catch((e) => console.error('[notices]', e));
  res.json({ ok: true });
});

adminRouter.get('/new-code', (req, res) => res.json({ code: randomCode(6) }));

/* ---------- categories ---------- */

adminRouter.get('/categories', async (req, res) => {
  const { data, error } = await supabase
    .from('categories').select('*').order('category_name', { ascending: true });
  if (error) return dbError(res, error, 500);
  res.json(data);
});

adminRouter.post('/categories', async (req, res) => {
  const name = String(req.body?.category_name || '').trim();
  if (!name) return res.status(400).json({ error: 'Название обязательно' });
  const { data, error } = await supabase
    .from('categories').insert({ category_name: name }).select().single();
  if (error) return dbError(res, error);
  res.status(201).json(data);
});

adminRouter.patch('/categories/:id', async (req, res) => {
  const name = String(req.body?.category_name || '').trim();
  if (!name) return res.status(400).json({ error: 'Название обязательно' });

  const { data: before } = await supabase
    .from('categories').select('category_name').eq('id', req.params.id).maybeSingle();

  const { data, error } = await supabase
    .from('categories')
    .update({ category_name: name, updated_at: new Date().toISOString() })
    .eq('id', req.params.id).select().single();
  if (error) return dbError(res, error);

  // items.item_category stores the NAME, so a rename has to follow through
  if (before?.category_name && before.category_name !== name) {
    await supabase.from('items')
      .update({ item_category: name }).eq('item_category', before.category_name);
  }
  res.json(data);
});

adminRouter.delete('/categories/:id', async (req, res) => {
  const { data: cat } = await supabase
    .from('categories').select('category_name').eq('id', req.params.id).maybeSingle();

  const { error } = await supabase.from('categories').delete().eq('id', req.params.id);
  if (error) return dbError(res, error);

  // orphan the items rather than delete them - they stay sellable, just uncategorised
  if (cat?.category_name) {
    await supabase.from('items')
      .update({ item_category: null }).eq('item_category', cat.category_name);
  }
  res.json({ ok: true });
});

/* ---------- materials ---------- */

adminRouter.get('/materials', async (req, res) => {
  const { data, error } = await supabase
    .from('materials').select('*').order('material_name', { ascending: true });
  if (error) return dbError(res, error, 500);
  res.json(data);
});

adminRouter.post('/materials', async (req, res) => {
  const body = pickMaterial(req.body);
  if (!body.material_name) return res.status(400).json({ error: 'Название обязательно' });
  const { data, error } = await supabase.from('materials').insert(body).select().single();
  if (error) return dbError(res, error);
  res.status(201).json(data);
});

adminRouter.patch('/materials/:id', async (req, res) => {
  const patch = { ...pickMaterial(req.body), updated_at: new Date().toISOString() };
  const { data, error } = await supabase
    .from('materials').update(patch).eq('id', req.params.id).select().single();
  if (error) return dbError(res, error);

  // items embed a snapshot of the material name, so keep those in step
  if (patch.material_name) {
    const { data: items } = await supabase.from('items').select('id, materials');
    for (const it of items || []) {
      const list = Array.isArray(it.materials) ? it.materials : [];
      if (!list.some((m) => String(m.id) === String(req.params.id))) continue;
      const next = list.map((m) =>
        String(m.id) === String(req.params.id) ? { ...m, name: patch.material_name } : m);
      await supabase.from('items').update({ materials: next }).eq('id', it.id);
    }
  }
  res.json(data);
});

adminRouter.delete('/materials/:id', async (req, res) => {
  const { error } = await supabase.from('materials').delete().eq('id', req.params.id);
  if (error) return dbError(res, error);

  const { data: items } = await supabase.from('items').select('id, materials');
  for (const it of items || []) {
    const list = Array.isArray(it.materials) ? it.materials : [];
    const next = list.filter((m) => String(m.id) !== String(req.params.id));
    if (next.length !== list.length) {
      await supabase.from('items').update({ materials: next }).eq('id', it.id);
    }
  }
  res.json({ ok: true });
});

/* ---------- items ---------- */

adminRouter.get('/items', async (req, res) => {
  const { data, error } = await supabase
    .from('items').select('*').order('id', { ascending: false });
  if (error) return dbError(res, error, 500);
  res.json(data);
});

adminRouter.post('/items', async (req, res) => {
  const body = pickItem(req.body);
  if (!body.item_name) return res.status(400).json({ error: 'Название обязательно' });
  const { data, error } = await supabase.from('items').insert(body).select().single();
  if (error) return dbError(res, error);
  res.status(201).json(data);
});

adminRouter.patch('/items/:id', async (req, res) => {
  const patch = { ...pickItem(req.body), updated_at: new Date().toISOString() };
  const { data, error } = await supabase
    .from('items').update(patch).eq('id', req.params.id).select().single();
  if (error) return dbError(res, error);
  res.json(data);
});

adminRouter.delete('/items/:id', async (req, res) => {
  const { error } = await supabase.from('items').delete().eq('id', req.params.id);
  if (error) return dbError(res, error);
  res.json({ ok: true });
});

/* ---------- companies ---------- */

adminRouter.get('/companies', async (req, res) => {
  const { data, error } = await supabase
    .from('companies').select('*').order('id', { ascending: false });
  if (error) return dbError(res, error, 500);
  res.json(data);
});

adminRouter.post('/companies', async (req, res) => {
  const body = pickCompany(req.body);
  if (!body.company_name) return res.status(400).json({ error: 'Название обязательно' });
  if (!body.company_code) body.company_code = randomCode(6);
  const { data, error } = await supabase.from('companies').insert(body).select().single();
  if (error) return dbError(res, error);
  res.status(201).json(data);
});

adminRouter.patch('/companies/:id', async (req, res) => {
  const patch = { ...pickCompany(req.body), updated_at: new Date().toISOString() };
  const { data, error } = await supabase
    .from('companies').update(patch).eq('id', req.params.id).select().single();
  if (error) return dbError(res, error);
  res.json(data);
});

adminRouter.delete('/companies/:id', async (req, res) => {
  // users and orders keep their rows; the FKs null out the link
  const { error } = await supabase.from('companies').delete().eq('id', req.params.id);
  if (error) return dbError(res, error);
  res.json({ ok: true });
});

/* ---------- orders ---------- */

adminRouter.get('/orders', async (req, res) => {
  const status = String(req.query.status || '').trim();
  let q = supabase
    .from('orders')
    .select('*, companies(company_name), users(user_name)')
    .order('created_at', { ascending: false })
    .limit(200);
  if (['new', 'confirmed', 'rejected'].includes(status)) q = q.eq('status', status);

  const { data, error } = await q;
  if (error) return dbError(res, error, 500);
  res.json(data);
});

/* Confirm or reject. Deciding twice is refused rather than silently
   re-notifying everyone. */
adminRouter.post('/orders/:id/decide', async (req, res) => {
  const status = req.body?.status;
  if (!['confirmed', 'rejected'].includes(status)) {
    return res.status(400).json({ error: 'Неверный статус' });
  }

  const { data: current, error: findErr } = await supabase
    .from('orders').select('id, status').eq('id', req.params.id).maybeSingle();
  if (findErr) return dbError(res, findErr, 500);
  if (!current) return res.status(404).json({ error: 'Заказ не найден' });
  if (current.status !== 'new') {
    return res.status(409).json({ error: 'Заказ уже обработан' });
  }

  const { data, error } = await supabase
    .from('orders')
    .update({ status, decided_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .select().single();
  if (error) return dbError(res, error);

  announceOrderDecision(data).catch((e) => console.error('[notices]', e));
  res.json(data);
});

/* ---------- app settings ---------- */

const SETTING_DEFAULTS = {
  catalog: { group_by_category: false },
  notifications: { notify_owner: true }
};

adminRouter.get('/settings', async (req, res) => {
  const { data, error } = await supabase.from('app_settings').select('key, value');
  if (error) return dbError(res, error, 500);
  const out = structuredClone(SETTING_DEFAULTS);
  for (const row of data || []) out[row.key] = { ...out[row.key], ...row.value };
  res.json(out);
});

adminRouter.put('/settings/notifications', async (req, res) => {
  const value = { notify_owner: !!req.body?.notify_owner };
  const { error } = await supabase.from('app_settings').upsert({
    key: 'notifications', value, updated_at: new Date().toISOString()
  });
  if (error) return dbError(res, error);
  res.json({ ok: true, value });
});

adminRouter.put('/settings/catalog', async (req, res) => {
  const value = { group_by_category: !!req.body?.group_by_category };

  // Grouping the app by category is only coherent if every item has one.
  if (value.group_by_category) {
    const { data: orphans, error } = await supabase
      .from('items').select('id, item_name').is('item_category', null);
    if (error) return dbError(res, error, 500);
    if (orphans?.length) {
      return res.status(409).json({
        error: 'Не у всех позиций указана категория',
        orphans: orphans.map((o) => ({ id: o.id, item_name: o.item_name }))
      });
    }
  }

  const { error } = await supabase.from('app_settings').upsert({
    key: 'catalog', value, updated_at: new Date().toISOString()
  });
  if (error) return dbError(res, error);
  res.json({ ok: true, value });
});

/* ---------- admin UI prefs (right accessibility panel) ---------- */

adminRouter.get('/prefs', async (req, res) => {
  const { data, error } = await supabase
    .from('admin_prefs').select('prefs').eq('admin_key', String(req.admin.id)).maybeSingle();
  if (error) return dbError(res, error, 500);
  res.json(data?.prefs || {});
});

adminRouter.put('/prefs', async (req, res) => {
  const { error } = await supabase.from('admin_prefs').upsert({
    admin_key: String(req.admin.id),
    prefs: req.body || {},
    updated_at: new Date().toISOString()
  });
  if (error) return dbError(res, error);
  res.json({ ok: true });
});

/* ---------- helpers ---------- */
function pickCompany(b = {}) {
  const out = {};
  if ('company_name' in b) out.company_name = b.company_name?.trim() || null;
  if ('company_code' in b) out.company_code = b.company_code?.trim() || null;
  if ('access' in b) out.access = !!b.access;
  return out;
}

function pickMaterial(b = {}) {
  const out = {};
  if ('material_name' in b) out.material_name = b.material_name?.trim() || null;
  if ('cost' in b) out.cost = toMoney(b.cost);
  return out;
}

function pickItem(b = {}) {
  const out = {};
  if ('item_name' in b) out.item_name = b.item_name?.trim() || null;
  if ('item_category' in b) out.item_category = b.item_category?.trim() || null;
  if ('item_cost' in b) out.item_cost = toMoney(b.item_cost);
  if ('materials' in b) {
    // store a {id, name} snapshot so an item still reads correctly if a
    // material is later renamed or removed
    out.materials = (Array.isArray(b.materials) ? b.materials : [])
      .map((m) => ({
        id: Number(m?.id),
        name: String(m?.name ?? '').trim(),
        qty: toQty(m?.qty)
      }))
      .filter((m) => Number.isFinite(m.id));
  }
  return out;
}

// Telegram chat ids are 64-bit signed; groups are negative
function toChatId(v) {
  const str = String(v ?? '').trim();
  if (!str) return null;
  return /^-?\d{1,20}$/.test(str) ? Number(str) : null;
}

// how many of a material go into one item; rows written before quantities
// existed have no qty, and those count as 1
function toQty(v) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n > 0 ? n : 1;
}

// item_cost / cost are bigint - whole units only
function toMoney(v) {
  if (v === '' || v === null || v === undefined) return null;
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= 0 ? n : null;
}


/* True when `id` is an admin with access and no other such admin exists. */
async function isLastAdmin(id) {
  const { data } = await supabase
    .from('users').select('id').eq('role', 'admin').eq('access', true);
  const admins = data || [];
  return admins.length <= 1 && admins.some((a) => String(a.id) === String(id));
}

function pickUser(b = {}) {
  const out = {};
  if ('user_name' in b) out.user_name = b.user_name?.trim() || null;
  if ('access' in b) out.access = !!b.access;
  if ('role' in b) {
    out.role = ['admin', 'owner', 'employee'].includes(b.role) ? b.role : 'employee';
  }
  if ('company_id' in b) {
    const n = Number(b.company_id);
    out.company_id = Number.isFinite(n) && n > 0 ? n : null;
  }
  if ('chat_id' in b) out.chat_id = toChatId(b.chat_id);
  return out;
}

// no 0/O/1/I — these codes get read off paper and typed on phones
function randomCode(len = 6) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < len; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
  return s;
}
