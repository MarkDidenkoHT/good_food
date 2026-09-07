import { Router } from 'express';
import { supabase, dbError } from '../lib/supabase.js';
import { requireUser } from '../lib/auth.js';
import { sendNewOrderNotice } from '../lib/notices.js';

export const appRouter = Router();
appRouter.use(requireUser);

/* Everything the mini-app needs. Materials and costs of materials never
   appear here — customers see items and prices only. */

appRouter.get('/catalog', async (req, res) => {
  const [items, categories, settings] = await Promise.all([
    supabase.from('items').select('id, item_name, item_category, item_cost').order('item_name'),
    supabase.from('categories').select('id, category_name').order('category_name'),
    supabase.from('app_settings').select('key, value').eq('key', 'catalog').maybeSingle()
  ]);

  if (items.error) return dbError(res, items.error, 500);
  if (categories.error) return dbError(res, categories.error, 500);

  res.json({
    items: items.data || [],
    categories: (categories.data || []).map((c) => c.category_name),
    group_by_category: Boolean(settings.data?.value?.group_by_category)
  });
});

appRouter.get('/orders', async (req, res) => {
  const { data, error } = await supabase
    .from('orders')
    .select('id, created_at, kind, status, items, total, comment, user_id')
    .eq('company_id', req.user.company_id)
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) return dbError(res, error, 500);
  res.json(data);
});

appRouter.post('/orders', async (req, res) => {
  const kind = req.body?.kind === 'return' ? 'return' : 'order';
  const comment = String(req.body?.comment || '').trim().slice(0, 500) || null;

  const wanted = Array.isArray(req.body?.items) ? req.body.items : [];
  if (!wanted.length) return res.status(400).json({ error: 'Корзина пуста' });

  // Price the order from the database, never from the client: the browser
  // sends ids and quantities, nothing about cost.
  const ids = [...new Set(wanted.map((l) => Number(l?.id)).filter(Number.isFinite))];
  if (!ids.length) return res.status(400).json({ error: 'Корзина пуста' });

  const { data: known, error } = await supabase
    .from('items').select('id, item_name, item_cost').in('id', ids);
  if (error) return dbError(res, error, 500);

  const byId = new Map((known || []).map((i) => [i.id, i]));
  const lines = [];
  for (const line of wanted) {
    const item = byId.get(Number(line?.id));
    if (!item) continue;
    const qty = Math.min(999, Math.max(1, Math.round(Number(line?.qty)) || 1));
    lines.push({ id: item.id, name: item.item_name, cost: item.item_cost ?? 0, qty });
  }
  if (!lines.length) return res.status(400).json({ error: 'Позиции не найдены' });

  const total = lines.reduce((acc, l) => acc + l.cost * l.qty, 0);

  const { data: order, error: insErr } = await supabase
    .from('orders')
    .insert({
      company_id: req.user.company_id,
      user_id: req.user.id,
      kind,
      status: 'new',
      items: lines,
      total,
      comment
    })
    .select().single();
  if (insErr) return dbError(res, insErr);

  sendNewOrderNotice(order).catch((e) => console.error('[notices]', e));
  res.status(201).json(order);
});
