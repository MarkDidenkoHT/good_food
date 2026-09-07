import { supabase } from './supabase.js';

/* The one place that decides whether a customer may still touch an order.
   Both the mini-app's list (which greys the buttons out) and the edit and
   delete endpoints (which refuse) go through here, so an app left open since
   before the deadline cannot slip an edit past the window. */

export const ORDER_DEFAULTS = { edit_window_minutes: 60, allow_delete_new: false };

export async function orderSettings() {
  const { data } = await supabase
    .from('app_settings').select('value').eq('key', 'orders').maybeSingle();
  return { ...ORDER_DEFAULTS, ...(data?.value || {}) };
}

// 0 minutes means editing is switched off, not "no deadline"
export function editWindow(settings) {
  const n = Math.round(Number(settings?.edit_window_minutes));
  return Number.isFinite(n) && n > 0 ? Math.min(n, 60 * 24 * 30) : 0;
}

export function editableUntil(order, settings) {
  const minutes = editWindow(settings);
  if (!minutes) return null;
  return new Date(new Date(order.created_at).getTime() + minutes * 60_000);
}

/* An order can be changed while it is still 'new' and inside the window.
   `locked` is set by the cron job and honoured too — if the job has already
   handed the order to the kitchen, the clock reading here is moot. */
export function canEdit(order, settings, now = new Date()) {
  if (order.status !== 'new' || order.locked) return false;
  const until = editableUntil(order, settings);
  return Boolean(until) && now < until;
}

export function canDelete(order, settings, now = new Date()) {
  return Boolean(settings?.allow_delete_new) && canEdit(order, settings, now);
}

/* Prices the basket from the database — the browser sends ids and quantities
   and nothing about cost, on an edit exactly as on a first submit. */
export async function priceLines(wanted) {
  const ids = [...new Set((wanted || []).map((l) => Number(l?.id)).filter(Number.isFinite))];
  if (!ids.length) return { lines: [], total: 0 };

  const { data: known, error } = await supabase
    .from('items').select('id, item_name, item_cost').in('id', ids);
  if (error) throw error;

  const byId = new Map((known || []).map((i) => [i.id, i]));
  const lines = [];
  for (const line of wanted) {
    const item = byId.get(Number(line?.id));
    if (!item) continue;
    const qty = Math.min(999, Math.max(1, Math.round(Number(line?.qty)) || 1));
    lines.push({ id: item.id, name: item.item_name, cost: item.item_cost ?? 0, qty });
  }
  return { lines, total: lines.reduce((acc, l) => acc + l.cost * l.qty, 0) };
}
