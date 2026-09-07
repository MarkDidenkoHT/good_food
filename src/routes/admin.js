import { Router } from 'express';
import { supabase, dbError } from '../lib/supabase.js';
import { requireAdmin } from '../lib/auth.js';
import { refreshUserNotice, announceOrderDecision } from '../lib/notices.js';
import { sendMessage, kitchenGroupId, esc as tgEsc } from '../lib/telegram.js';
import { uploadImage, removeImage, signedUrl, MAX_BYTES, extFor } from '../lib/storage.js';
import { ORDER_DEFAULTS, parseTime } from '../lib/orders.js';
import express from 'express';

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
    .from('categories')
    .insert({ category_name: name, image_path: req.body?.image_path?.trim() || null })
    .select().single();
  if (error) return dbError(res, error);
  res.status(201).json(data);
});

adminRouter.patch('/categories/:id', async (req, res) => {
  const name = String(req.body?.category_name || '').trim();
  if (!name) return res.status(400).json({ error: 'Название обязательно' });

  const { data: before } = await supabase
    .from('categories').select('category_name, image_path').eq('id', req.params.id).maybeSingle();

  const patch = { category_name: name, updated_at: new Date().toISOString() };
  if ('image_path' in req.body) patch.image_path = req.body.image_path?.trim() || null;

  const { data, error } = await supabase
    .from('categories').update(patch).eq('id', req.params.id).select().single();
  if (error) return dbError(res, error);

  // the replaced picture is now unreachable, so drop it from the bucket
  if ('image_path' in patch && before?.image_path && before.image_path !== patch.image_path) {
    removeImage(before.image_path);
  }

  // items.item_category stores the NAME, so a rename has to follow through
  if (before?.category_name && before.category_name !== name) {
    await supabase.from('items')
      .update({ item_category: name }).eq('item_category', before.category_name);
  }
  res.json(data);
});

adminRouter.delete('/categories/:id', async (req, res) => {
  const { data: cat } = await supabase
    .from('categories').select('category_name, image_path').eq('id', req.params.id).maybeSingle();
  if (cat?.image_path) removeImage(cat.image_path);

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

  const { data: before } = await supabase
    .from('items').select('image_path').eq('id', req.params.id).maybeSingle();

  const { data, error } = await supabase
    .from('items').update(patch).eq('id', req.params.id).select().single();
  if (error) return dbError(res, error);

  if ('image_path' in patch && before?.image_path && before.image_path !== patch.image_path) {
    removeImage(before.image_path);
  }
  res.json(data);
});

adminRouter.delete('/items/:id', async (req, res) => {
  const { data: before } = await supabase
    .from('items').select('image_path').eq('id', req.params.id).maybeSingle();

  const { error } = await supabase.from('items').delete().eq('id', req.params.id);
  if (error) return dbError(res, error);

  if (before?.image_path) removeImage(before.image_path);
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

/* The date range is the only server-side filter: status, type and company are
   narrowed in the browser so those controls never wait on a request. */
adminRouter.get('/orders', async (req, res) => {
  const { from, to } = req.query;
  let q = supabase
    .from('orders')
    .select('*, companies(company_name), users(user_name)')
    .order('created_at', { ascending: false })
    .limit(1000);

  if (from) q = q.gte('created_at', String(from));
  if (to) q = q.lte('created_at', String(to));

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

/* What the kitchen has to make for a set of orders: the items, and the
   materials those items consume. Returns are excluded — nothing is prepared
   for goods coming back. Materials live only here and in the panel; the
   mini-app never sees them. */
async function summarise(ids) {
  const { data: orders, error } = await supabase
    .from('orders').select('id, kind, items, total').in('id', ids);
  if (error) throw error;

  const prep = (orders || []).filter((o) => o.kind === 'order');

  // item id -> units to make
  const itemQty = new Map();
  for (const o of prep) {
    for (const line of Array.isArray(o.items) ? o.items : []) {
      const id = Number(line.id);
      if (!Number.isFinite(id)) continue;
      itemQty.set(id, (itemQty.get(id) || 0) + (Number(line.qty) || 0));
    }
  }

  const { data: catalog, error: cErr } = await supabase
    .from('items').select('id, item_name, materials').in('id', [...itemQty.keys()]);
  if (cErr) throw cErr;

  const byId = new Map((catalog || []).map((i) => [i.id, i]));
  const { data: allMaterials } = await supabase.from('materials').select('id, material_name, cost');
  const matById = new Map((allMaterials || []).map((m) => [m.id, m]));

  const items = [];
  const materials = new Map();   // material id -> { name, qty, cost }

  for (const [id, qty] of itemQty) {
    const item = byId.get(id);
    items.push({ id, name: item?.item_name || `#${id}`, qty });

    for (const m of Array.isArray(item?.materials) ? item.materials : []) {
      const meta = matById.get(Number(m.id));
      const need = (Number(m.qty) || 1) * qty;
      const cur = materials.get(m.id) ||
        { id: m.id, name: meta?.material_name || m.name || `#${m.id}`, qty: 0, cost: meta?.cost ?? 0 };
      cur.qty += need;
      materials.set(m.id, cur);
    }
  }

  const list = [...materials.values()]
    .map((m) => ({ ...m, total: m.qty * (m.cost || 0) }))
    .sort((a, b) => a.name.localeCompare(b.name, 'ru'));

  return {
    order_count: prep.length,
    items: items.sort((a, b) => a.name.localeCompare(b.name, 'ru')),
    materials: list,
    materials_total: list.reduce((a, m) => a + m.total, 0)
  };
}

adminRouter.post('/orders/summary', async (req, res) => {
  const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).map(Number).filter(Number.isFinite);
  if (!ids.length) return res.status(400).json({ error: 'Нет выбранных заказов' });
  try {
    res.json(await summarise(ids));
  } catch (e) {
    return dbError(res, e, 500);
  }
});

/* Post the prep list to the kitchen group. */
adminRouter.post('/orders/send-kitchen', async (req, res) => {
  const group = kitchenGroupId();
  if (!group) {
    return res.status(400).json({ error: 'TELEGRAM_KITCHEN_GROUP_ID не задан' });
  }

  const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).map(Number).filter(Number.isFinite);
  if (!ids.length) return res.status(400).json({ error: 'Нет выбранных заказов' });

  let summary;
  try {
    summary = await summarise(ids);
  } catch (e) {
    return dbError(res, e, 500);
  }
  if (!summary.items.length) {
    return res.status(400).json({ error: 'В выборке нет заказов на приготовление' });
  }

  const when = new Date().toLocaleString('ru-RU', {
    timeZone: 'Europe/Chisinau', dateStyle: 'short', timeStyle: 'short'
  });

  const text = [
    '<b>Список на приготовление</b>',
    `Заказов: ${summary.order_count}`,
    '',
    '<b>Позиции</b>',
    ...summary.items.map((i) => `• ${tgEsc(i.name)} — ${i.qty} шт.`),
    '',
    '<b>Материалы</b>',
    ...summary.materials.map((m) => `• ${tgEsc(m.name)} — ${m.qty} шт.`),
    '',
    `Себестоимость материалов: <b>${summary.materials_total} ₽</b>`,
    `<i>отправлено ${when}</i>`
  ].join('\n');

  const sent = await sendMessage(group, text);
  if (!sent?.ok) return res.status(502).json({ error: 'Telegram не принял сообщение' });
  res.json({ ok: true, ...summary });
});

/* ---------- images ---------- */

/* Raw body rather than multipart: one file, no form fields, and no parser
   dependency. The browser posts the File straight through. */
adminRouter.post('/images',
  express.raw({ type: ['image/*'], limit: MAX_BYTES }),
  async (req, res) => {
    const contentType = req.get('content-type');
    if (!extFor(contentType)) {
      return res.status(415).json({ error: 'Поддерживаются JPEG, PNG, WebP и GIF' });
    }
    const folder = req.query.folder === 'categories' ? 'categories' : 'items';
    try {
      const path = await uploadImage(req.body, contentType, folder);
      res.status(201).json({ path });
    } catch (e) {
      res.status(400).json({ error: e.message || 'Не удалось загрузить' });
    }
  });

/* Redirect to a signed link so <img src="/api/admin/images/view?path=..">
   just works in the panel while the bucket stays private. */
adminRouter.get('/images/view', async (req, res) => {
  const url = await signedUrl(String(req.query.path || ''), 3600);
  if (!url) return res.status(404).json({ error: 'Нет изображения' });
  res.redirect(url);
});

adminRouter.delete('/images', async (req, res) => {
  await removeImage(String(req.query.path || ''));
  res.json({ ok: true });
});

/* ---------- app settings ---------- */

const SETTING_DEFAULTS = {
  catalog: { group_by_category: false, show_images: false },
  notifications: { notify_owner: true },
  orders: ORDER_DEFAULTS
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

/* Until when an unapproved order stays editable, what happens to orders sent
   after that, and whether cancelling is offered at all. The mini-app reads the
   same row to decide what to draw; the API enforces it. */
adminRouter.put('/settings/orders', async (req, res) => {
  const { data: current } = await supabase
    .from('app_settings').select('value').eq('key', 'orders').maybeSingle();
  const value = { ...SETTING_DEFAULTS.orders, ...(current?.value || {}) };

  if ('cutoff_enabled' in req.body) value.cutoff_enabled = !!req.body.cutoff_enabled;
  if ('allow_delete_new' in req.body) value.allow_delete_new = !!req.body.allow_delete_new;

  for (const key of ['cutoff_time', 'resume_time']) {
    if (!(key in req.body)) continue;
    const time = parseTime(req.body[key]);
    if (!time) return res.status(400).json({ error: 'Укажите время в формате ЧЧ:ММ' });
    value[key] = time.text;
  }

  if ('after_cutoff' in req.body) {
    value.after_cutoff = req.body.after_cutoff === 'block' ? 'block' : 'next_day';
  }

  const { error } = await supabase.from('app_settings').upsert({
    key: 'orders', value, updated_at: new Date().toISOString()
  });
  if (error) return dbError(res, error);
  res.json({ ok: true, value });
});

adminRouter.put('/settings/catalog', async (req, res) => {
  // Read-modify-write: the panel saves one toggle at a time.
  const { data: current } = await supabase
    .from('app_settings').select('value').eq('key', 'catalog').maybeSingle();
  const value = { ...SETTING_DEFAULTS.catalog, ...(current?.value || {}) };

  if ('group_by_category' in req.body) value.group_by_category = !!req.body.group_by_category;
  if ('show_images' in req.body) value.show_images = !!req.body.show_images;

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
  if ('image_path' in b) out.image_path = b.image_path?.trim() || null;
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
