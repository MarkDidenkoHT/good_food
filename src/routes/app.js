import { Router } from 'express';
import { supabase, dbError } from '../lib/supabase.js';
import { requireUser } from '../lib/auth.js';
import { sendNewOrderNotice, sendOrderEditedNotice, markOrderDeleted } from '../lib/notices.js';
import { signedUrlMap } from '../lib/storage.js';
import { orderSettings, editDeadline, canEdit, canDelete, editableStatuses,
         orderingWindow, serviceDateFor, priceLines, TZ } from '../lib/orders.js';

export const appRouter = Router();
appRouter.use(requireUser);

/* Everything the mini-app needs. Materials and costs of materials never
   appear here — customers see items and prices only. */

appRouter.get('/catalog', async (req, res) => {
  const [items, categories, settings, orders] = await Promise.all([
    supabase.from('items')
      .select('id, item_name, item_category, item_cost, image_path').order('item_name'),
    supabase.from('categories').select('id, category_name, image_path').order('category_name'),
    supabase.from('app_settings').select('key, value').eq('key', 'catalog').maybeSingle(),
    orderSettings()
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
    orders: orderRules(orders)
  });
});

/* What the mini-app needs before it has asked to do anything: whether the
   buttons should be there at all, and whether orders are being taken right
   now. Every endpoint checks the same rules again on the way in. */
function orderRules(settings, now = new Date()) {
  const window = orderingWindow(settings, now);
  return {
    cutoff_enabled: Boolean(settings.cutoff_enabled),
    cutoff_time: settings.cutoff_time,
    allow_delete_new: Boolean(settings.allow_delete_new),
    allow_edit_confirmed: Boolean(settings.allow_edit_confirmed),
    ordering_blocked: window.blocked,
    resumes_at: window.resumes_at?.toISOString() || null,
    service_date: window.service_date,
    // the order goes on tomorrow's list even though it is accepted now
    for_next_day: window.service_date !== serviceDateFor({ cutoff_enabled: false }, now)
  };
}

appRouter.get('/orders', async (req, res) => {
  const [{ data, error }, settings] = await Promise.all([
    supabase
      .from('orders')
      .select('id, created_at, kind, status, items, total, comment, user_id, edited_at, service_date')
      .eq('company_id', req.user.company_id)
      .order('created_at', { ascending: false })
      .limit(50),
    orderSettings()
  ]);
  if (error) return dbError(res, error, 500);

  const now = new Date();
  res.json((data || []).map((o) => ({
    ...o,
    editable_until: editDeadline(o, settings)?.toISOString() || null,
    can_edit: canEdit(o, settings, now),
    can_delete: canDelete(o, settings, now)
  })));
});

appRouter.post('/orders', async (req, res) => {
  const settings = await orderSettings();

  // Under 'block' the shop stops taking orders between the cutoff and the
  // next morning; under 'next_day' it keeps taking them for tomorrow.
  const window = orderingWindow(settings);
  if (window.blocked) {
    return res.status(409).json({
      error: 'Приём заказов закрыт до ' + hhmm(window.resumes_at),
      resumes_at: window.resumes_at?.toISOString() || null
    });
  }

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
      comment,
      service_date: window.service_date
    })
    .select().single();
  if (insErr) return dbError(res, insErr);

  sendNewOrderNotice(order).catch((e) => console.error('[notices]', e));
  res.status(201).json(order);
});

/* Edit an order the customer already sent. Allowed while the status is one
   Настройки still opens (always «Новый», and «Подтверждён» when editing
   approved orders is switched on) and today's cutoff has not passed — an app
   opened before the cutoff gets the same answer as one opened after it,
   because the check is here and not in the browser. The basket is re-priced
   from the catalog, so an edit can never carry a stale or invented price. */
appRouter.patch('/orders/:id', async (req, res) => {
  const settings = await orderSettings();

  const { data: order, error: findErr } = await supabase
    .from('orders')
    .select('id, company_id, user_id, kind, status, created_at, service_date, notice_message_id')
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
    return res.status(409).json({ error: closedMessage(order, settings) });
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
    // lost the race with an admin decision that closed the order
    .in('status', editableStatuses(settings))
    .select().single();
  if (error) return dbError(res, error);

  sendOrderEditedNotice(updated).catch((e) => console.error('[notices]', e));
  res.json(updated);
});

/* Cancel an order nobody has approved yet — only when Настройки allows it,
   and only before the same cutoff. */
appRouter.delete('/orders/:id', async (req, res) => {
  const settings = await orderSettings();
  if (!settings.allow_delete_new) {
    return res.status(403).json({ error: 'Удаление заказов отключено' });
  }

  const { data: order, error: findErr } = await supabase
    .from('orders')
    .select('id, company_id, user_id, kind, status, created_at, service_date, items, total, comment, notice_message_id')
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
    return res.status(409).json({ error: closedMessage(order, settings) });
  }

  const { error } = await supabase
    .from('orders').delete().eq('id', order.id).eq('status', 'new');
  if (error) return dbError(res, error);

  markOrderDeleted(order).catch((e) => console.error('[notices]', e));
  res.json({ ok: true });
});

/* Say which of the two closed the order, since the customer can do something
   about neither but should not be left guessing. */
function closedMessage(order, settings) {
  if (order.status === 'rejected') return 'Заказ отклонён';
  if (order.status !== 'new' && !settings?.allow_edit_confirmed) {
    return 'Заказ уже подтверждён — изменить нельзя';
  }
  const deadline = editDeadline(order, settings);
  return `Изменение закрыто в ${hhmm(deadline)} — заказ уже в работе`;
}

// the local clock the cutoff is written in, for messages back to the customer
function hhmm(date) {
  return date
    ? date.toLocaleTimeString('ru-RU', { timeZone: TZ, hour: '2-digit', minute: '2-digit' })
    : '';
}
