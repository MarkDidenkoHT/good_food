import { Router } from 'express';
import { supabase, dbError } from '../lib/supabase.js';
import { requireUser, issueUserSession } from '../lib/auth.js';
import { requireFreshCode, rotateCompanyCode } from '../lib/companyCode.js';
import { sendNewOrderNotice, sendOrderEditedNotice, markOrderDeleted } from '../lib/notices.js';
import { signedUrlMap } from '../lib/storage.js';
import { orderSettings, editDeadline, canEdit, canDelete, editableStatuses,
         orderingWindow, serviceDateFor, priceLines, blockedMessage,
         returnableFrom, priceReturn, overMessage, TZ }
  from '../lib/orders.js';

export const appRouter = Router();
appRouter.use(requireUser);
/* A session outlives a reissued code by up to thirty days unless somebody
   checks, and the whole point of reissuing one is to reach the people who
   are using the app right now. */
appRouter.use(requireFreshCode);

/* Everything the mini-app needs. Materials and costs of materials never
   appear here — customers see items and prices only. */

/* Owners may hold their own kill switch, but only where the operator has
   said so. Read on every use: withdrawing the permission has to take effect
   without waiting for anybody to reload anything. */
async function ownerResetAllowed() {
  const { data } = await supabase
    .from('app_settings').select('value').eq('key', 'auth').maybeSingle();
  return data?.value?.allow_owner_reset === true;
}

/* Reissue the company code from inside the app.

   The owner is left signed in — they are standing in the app and they have
   just been handed the code — while everyone else in the company is stopped
   where they are and told, in Telegram, to ask the owner for it. */
appRouter.post('/company/rotate-code', async (req, res) => {
  if (req.user.company_role !== 'owner') {
    return res.status(403).json({ error: 'Перевыпустить код может только владелец компании' });
  }
  if (!await ownerResetAllowed()) {
    return res.status(403).json({ error: 'Перевыпуск кода отключён — обратитесь к менеджеру' });
  }

  const { company, code, affected, notFound, error } =
    await rotateCompanyCode(req.user.company_id, {
      actorName: req.user.name, keepUserId: req.user.id
    });
  if (notFound) return res.status(404).json({ error: 'Компания не найдена' });
  if (error) return dbError(res, error);

  // their own session was issued against the code they just replaced
  issueUserSession(res, {
    id: req.user.id,
    user_name: req.user.name,
    company_id: req.user.company_id,
    role: req.user.company_role,
    code_version: company.code_version
  });

  res.json({ ok: true, company_code: code, affected });
});

appRouter.get('/catalog', async (req, res) => {
  const [items, categories, settings, orders, ownerReset] = await Promise.all([
    supabase.from('items')
      .select('id, item_name, item_category, item_cost, image_path, available')
      .order('item_name'),
    supabase.from('categories').select('id, category_name, image_path').order('category_name'),
    supabase.from('app_settings').select('key, value').eq('key', 'catalog').maybeSingle(),
    orderSettings(),
    ownerResetAllowed()
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

  // Withdrawn items ship too: the mini-app hides them from the order list but
  // still offers them for a return.
  res.json({
    show_images: showImages,
    // no size to honour when the images are off
    image_size: showImages ? (settings.data?.value?.image_size || 'md') : 'md',
    items: rows.map(({ image_path, available, ...i }) => ({
      ...i,
      available: available !== false,
      image: showImages ? urls[image_path] || null : null
    })),
    categories: cats.map((c) => ({
      name: c.category_name,
      image: showImages ? urls[c.image_path] || null : null
    })),
    group_by_category: Boolean(settings.data?.value?.group_by_category),
    orders: orderRules(orders),
    // draws the owner's «Перевыпустить код» button, and nothing more — the
    // endpoint checks both halves again for itself
    can_reset_code: ownerReset && req.user.company_role === 'owner'
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
    // hides the Возврат tab: returns are then started from a past order
    returns_from_history: Boolean(settings.returns_from_history),
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
      .select('id, created_at, kind, status, items, total, comment, user_id, edited_at, ' +
              'service_date, source_order_id')
      .eq('company_id', req.user.company_id)
      .order('created_at', { ascending: false })
      .limit(50),
    orderSettings()
  ]);
  if (error) return dbError(res, error, 500);

  const rows = data || [];

  /* With returns driven from history, each order has to say how much of it is
     still returnable — the ordered quantity less everything already sent back
     against it. One pass over the returns already in hand, so the list costs
     no extra queries. */
  const returned = new Map();                 // source order id -> item id -> qty
  if (settings.returns_from_history) {
    for (const r of rows) {
      if (r.kind !== 'return' || !r.source_order_id || r.status === 'rejected') continue;
      const per = returned.get(String(r.source_order_id)) || new Map();
      for (const l of Array.isArray(r.items) ? r.items : []) {
        const id = Number(l.id);
        per.set(id, (per.get(id) || 0) + (Number(l.qty) || 0));
      }
      returned.set(String(r.source_order_id), per);
    }
  }

  const returnableLines = (o) => {
    const used = returned.get(String(o.id)) || new Map();
    return (Array.isArray(o.items) ? o.items : []).map((l) => {
      const id = Number(l.id);
      const qty = Number(l.qty) || 0;
      return { id, name: l.name, cost: Number(l.cost) || 0, qty,
               left: Math.max(0, qty - (used.get(id) || 0)) };
    }).filter((l) => l.left > 0);
  };

  const now = new Date();
  res.json(rows.map((o) => {
    const out = {
      ...o,
      editable_until: editDeadline(o, settings)?.toISOString() || null,
      can_edit: canEdit(o, settings, now),
      can_delete: canDelete(o, settings, now)
    };
    if (settings.returns_from_history && o.kind === 'order' && o.status !== 'rejected') {
      out.returnable = returnableLines(o);
    }
    return out;
  }));
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
  let lines;
  let total;
  let sourceId = null;

  if (kind === 'return' && settings.returns_from_history) {
    // A return is a claim against something actually bought, so it is priced
    // from that order's snapshot and capped by what is left of it.
    sourceId = Number(req.body?.source_order_id) || null;
    if (!sourceId) {
      return res.status(400).json({ error: 'Возврат оформляется из истории заказов' });
    }

    let returnable;
    try {
      returnable = await returnableFrom(sourceId, req.user.company_id);
    } catch (e) {
      return dbError(res, e, 500);
    }
    if (!returnable) return res.status(404).json({ error: 'Заказ не найден' });

    const priced = priceReturn(wanted, returnable);
    if (priced.over.length) return res.status(409).json({ error: overMessage(priced.over) });
    if (!priced.lines.length) {
      return res.status(400).json({ error: 'Из этого заказа нечего вернуть' });
    }
    ({ lines, total } = priced);
  } else {
    // Availability is checked here too — a basket may have been filled before
    // an item was withdrawn.
    let priced;
    try {
      priced = await priceLines(wanted, { forOrder: kind === 'order' });
    } catch (e) {
      return dbError(res, e, 500);
    }
    if (priced.blocked.length) {
      return res.status(409).json({ error: blockedMessage(priced.blocked) });
    }
    if (!priced.lines.length) return res.status(400).json({ error: 'Позиции не найдены' });
    ({ lines, total } = priced);
  }

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
      source_order_id: sourceId,
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
    priced = await priceLines(wanted, { forOrder: order.kind !== 'return' });
  } catch (e) {
    return dbError(res, e, 500);
  }
  const { lines, total, blocked } = priced;
  if (blocked.length) return res.status(409).json({ error: blockedMessage(blocked) });
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
