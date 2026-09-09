/* FrontPad — foundation only. NOTHING IS SENT ANYWHERE YET.
 *
 * Every path below ends at console.log. The point of having the module now is
 * that the two decisions an eventual integration rests on are already made and
 * visible in the logs:
 *
 *   1. WHEN an order goes out — on confirmation, or batched at a fixed time.
 *      Settings → FrontPad picks between them; `frontpadMode()` reads it.
 *   2. WHAT would go out — resolved through items.frontpad_id, so a position
 *      without an article is a hole that shows up here rather than at the
 *      moment someone first turns the switch on in production.
 *
 * Replacing the log with a real POST should be the only change needed.
 */

import { supabase } from './supabase.js';

const KEY = () => process.env.FRONTPAD_APIKEY || '';

export const frontpadConfigured = () => !!KEY();

export const FRONTPAD_DEFAULTS = {
  enabled: false,
  mode: 'on_confirm',   // 'on_confirm' | 'batch'
  batch_time: '18:00'
};

export async function frontpadSettings() {
  const { data } = await supabase
    .from('app_settings').select('value').eq('key', 'frontpad').maybeSingle();
  return { ...FRONTPAD_DEFAULTS, ...(data?.value || {}) };
}

/* Builds the payload an order WOULD be sent as and logs it.
 *
 * Returns are never included: FrontPad has no counterpart for goods coming
 * back, so sending one would create a phantom sale.
 *
 * `reason` says which of the two modes brought us here, so the log reads the
 * same whether it came from a confirmation or a batch run. */
export async function pushOrder(order, reason = 'on_confirm') {
  const tag = `[frontpad] order #${order?.id}`;

  if (order?.kind === 'return') {
    console.log(`${tag} skipped — returns are not sent to FrontPad`);
    return { skipped: 'return' };
  }

  const settings = await frontpadSettings();
  if (!settings.enabled) {
    console.log(`${tag} skipped — integration is off (Настройки → FrontPad)`);
    return { skipped: 'disabled' };
  }
  if (!frontpadConfigured()) {
    console.warn(`${tag} skipped — FRONTPAD_APIKEY is not set`);
    return { skipped: 'no_key' };
  }

  const lines = Array.isArray(order?.items) ? order.items : [];
  const ids = [...new Set(lines.map((l) => Number(l?.id)).filter(Number.isFinite))];
  const { data: items } = ids.length
    ? await supabase.from('items').select('id, item_name, frontpad_id').in('id', ids)
    : { data: [] };
  const byId = new Map((items || []).map((i) => [i.id, i]));

  const product = [];
  const missing = [];
  for (const line of lines) {
    const item = byId.get(Number(line?.id));
    const article = item?.frontpad_id;
    if (!article) {
      missing.push(item?.item_name || line?.name || `#${line?.id}`);
      continue;
    }
    product.push({ article, count: Number(line?.qty) || 0 });
  }

  /* An order with an unmapped position cannot be sent complete, and a silently
     short order is worse for a kitchen than one that never arrived — so this
     refuses rather than sending the rest. */
  if (missing.length) {
    console.warn(`${tag} NOT SENT — нет артикула FrontPad: ${missing.join(', ')}`);
    return { skipped: 'unmapped', missing };
  }

  console.log(`${tag} would send (${reason}):`, JSON.stringify({
    product,
    descr: order?.comment || '',
    total: order?.total ?? 0
  }));
  return { would_send: product };
}

/* The batch mode's entry point. Wired to nothing yet — when it is, the caller
   is the existing cron tick, which already runs every five minutes. */
export async function pushDueOrders() {
  const settings = await frontpadSettings();
  if (!settings.enabled || settings.mode !== 'batch') return { skipped: 'not_batch' };

  const { data: orders } = await supabase
    .from('orders').select('*').eq('status', 'confirmed').eq('kind', 'order');

  console.log(`[frontpad] batch at ${settings.batch_time} — ${orders?.length || 0} confirmed order(s)`);
  for (const order of orders || []) await pushOrder(order, 'batch');
  return { count: orders?.length || 0 };
}
