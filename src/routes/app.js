import { Router } from 'express';
import { supabase, dbError } from '../lib/supabase.js';
import { requireUser } from '../lib/auth.js';
import { sendNewOrderNotice, sendOrderEditedNotice, markOrderDeleted } from '../lib/notices.js';
import { signedUrlMap } from '../lib/storage.js';
import { orderSettings, editWindow, editableUntil, canEdit, canDelete, priceLines }
  from '../lib/orders.js';

export const appRouter = Router();
appRouter.use(requireUser);

/* Everything the mini-app needs. Materials and costs of materials never
   appear here — customers see items and prices only. */

appRouter.get('/catalog', async (req, res) => {
  const [items, categories, settings] = await Promise.all([
    supabase.from('items')
      .select('id, item_name, item_category, item_cost, image_path').order('item_name'),
    supabase.from('categories').select('id, category_name, image_path').order('category_name'),
    supabase.from('app_settings').select('key, value').eq('key', 'catalog').maybeSingle()
  ]);

  if (items.error) return dbError(res, items.error, 500);
  if (categories.error) return dbError(res, categories.error, 500);

  const showImages = Boolean(settings.data?.value?.show_images);
  const rows = items.data || [];
  const cats = categories.data || [];

  // The bucket is private: hand out short-lived signed links, and only when
  // images are switched on. image_path itself never reaches the client.
  const urls = showImages
    ? await signedUrlMap([...rows, ...cats].map((r) => r.image_path))
    : {};

  res.json({
    show_images: showImages,
    items: rows.map(({ image_path, ...i }) => ({
      ...i, image: showImages ? urls[image_path] || null : null
    })),
    categories: cats.map((c) => ({
      name: c.category_name,
      image: showImages ? urls[c.image_path] || null : null
    })),
    group_by_category: Boolean(settings.data?.value?.group_by_category),
    orders: await orderRules()
  });
});

/* What the mini-app needs to draw the edit and delete buttons before it has
   asked to use them. The endpoints check the same rule again on the way in. */
async function orderRules() {
  const settings = await orderSettings();
  return {
    edit_window_minutes: editWindow(settings),
    allow_delete_new: Boolean(settings.allow_delete_new)
  };
}

appRouter.get('/orders', async (req, res) => {
  const [{ data, error }, settings] = await Promise.all([
    supabase
      .from('orders')
      .select('id, created_at, kind, status, items, total, comment, user_id, locked, edited_at')
      .eq('company_id', req.user.company_id)
      .order('created_at', { ascending: false })
      .limit(50),
    orderSettings()
  ]);
  if (error) return dbError(res, error, 500);

  const now = new Date();
  res.json((data || []).map((o) => ({
    ...o,
    editable_until: editableUntil(o, settings)?.toISOString() || null,
    can_edit: canEdit(o, settings, now),
    can_delete: canDelete(o, settings, now)
  })));
});

appRouter.post('/orders', async (req, res) => {
  const kind = req.body?.kind === 'return' ? 'return' : 'order';
  const comment = String(req.body?.comment || '').trim().slice(0, 500) || null;

  const wanted = Array.isArray(req.body?.items) ? req.body.items : [];
  if (!wanted.length) return res.status(400).json({ error: 'Корзина пуста' });

  // Price the order from the database, never from the client: the browser
  // sends ids and quantities, nothing about cost.
  let priced;
  try {
    priced = await priceLines(wanted);
  } catch (e) {
    return dbError(res, e, 500);
  }
  const { lines, total } = priced;
  if (!lines.length) return res.status(400).json({ error: 'Позиции не найдены' });

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

/* Edit an order the customer already sent. Allowed only while it is 'new' and
   inside the window from Настройки — an app opened before the deadline gets
   the same answer as one opened after it, because the check is here and not
   in the browser. The basket is re-priced from the catalog, so an edit can
   never carry a stale or invented price. */
appRouter.patch('/orders/:id', async (req, res) => {
  const settings = await orderSettings();

  const { data: order, error: findErr } = await supabase
    .from('orders')
    .select('id, company_id, user_id, kind, status, locked, created_at, notice_message_id')
    .eq('id', req.params.id)
    .maybeSingle();
  if (findErr) return dbError(res, findErr, 500);
  if (!order || order.company_id !== req.user.company_id) {
    return res.status(404).json({ error: 'Заказ не найден' });
  }
  if (order.user_id !== req.user.id) {
    return res.status(403).json({ error: 'Это заказ другого сотрудника' });
  }
  if (!canEdit(order, settings)) {
    return res.status(409).json({ error: 'Время на изменение заказа истекло' });
  }

  const wanted = Array.isArray(req.body?.items) ? req.body.items : [];
  if (!wanted.length) return res.status(400).json({ error: 'Корзина пуста' });

  let priced;
  try {
    priced = await priceLines(wanted);
  } catch (e) {
    return dbError(res, e, 500);
  }
  const { lines, total } = priced;
  if (!lines.length) return res.status(400).json({ error: 'Позиции не найдены' });

  const patch = {
    items: lines,
    total,
    edited_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  if ('comment' in (req.body || {})) {
    patch.comment = String(req.body.comment || '').trim().slice(0, 500) || null;
  }

  const { data: updated, error } = await supabase
    .from('orders')
    .update(patch)
    .eq('id', order.id)
    .eq('status', 'new')          // lost the race with an admin decision
    .select().single();
  if (error) return dbError(res, error);

  sendOrderEditedNotice(updated).catch((e) => console.error('[notices]', e));
  res.json(updated);
});

/* Delete an order that has not been approved yet — only when Настройки allows
   it, and only inside the same window. */
appRouter.delete('/orders/:id', async (req, res) => {
  const settings = await orderSettings();
  if (!settings.allow_delete_new) {
    return res.status(403).json({ error: 'Удаление заказов отключено' });
  }

  const { data: order, error: findErr } = await supabase
    .from('orders')
    .select('id, company_id, user_id, kind, status, locked, created_at, items, total, comment, notice_message_id')
    .eq('id', req.params.id)
    .maybeSingle();
  if (findErr) return dbError(res, findErr, 500);
  if (!order || order.company_id !== req.user.company_id) {
    return res.status(404).json({ error: 'Заказ не найден' });
  }
  if (order.user_id !== req.user.id) {
    return res.status(403).json({ error: 'Это заказ другого сотрудника' });
  }
  if (!canDelete(order, settings)) {
    return res.status(409).json({ error: 'Время на изменение заказа истекло' });
  }

  const { error } = await supabase
    .from('orders').delete().eq('id', order.id).eq('status', 'new');
  if (error) return dbError(res, error);

  markOrderDeleted(order).catch((e) => console.error('[notices]', e));
  res.json({ ok: true });
});
