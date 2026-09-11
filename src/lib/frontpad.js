/* FrontPad — sending confirmed orders, the way the old Google Sheets script did.
 *
 *   POST https://app.frontpad.ru/api/index.php?new_order
 *   form-urlencoded: secret, name, descr, datetime, phone?, product[i], product_kol[i]
 *
 * Two switches decide what actually happens:
 *   simulation — everything is built exactly as for real (articles, payload,
 *                datetime) and logged, but no request leaves the server.
 *   verbose    — the full trail in the server log (article map, each line,
 *                raw response), like the old script's _log calls.
 *
 * Every attempt, simulated or real, is written to frontpad_log so it can be
 * read back from the admin panel after Render's logs have rolled over.
 *
 * Returns are skipped unless «Передавать возвраты» is on; then they go out
 * with each item's return article (frontpad_return_id).
 */

import { supabase } from './supabase.js';
import { localDate } from './orders.js';

const API = 'https://app.frontpad.ru/api/index.php';
const KEY = () => process.env.FRONTPAD_APIKEY || '';

export const frontpadConfigured = () => !!KEY();

export const FRONTPAD_DEFAULTS = {
  enabled: false,
  simulation: true,        // on until someone deliberately switches it off
  verbose: true,
  send_returns: false,
  delivery_time: '10:00'   // FrontPad datetime = service day + 1 at this time
};

export async function frontpadSettings() {
  const { data } = await supabase
    .from('app_settings').select('value').eq('key', 'frontpad').maybeSingle();
  return { ...FRONTPAD_DEFAULTS, ...(data?.value || {}) };
}

/* ── logging ──────────────────────────────────────────────────────────── */

function logger(orderId, verbose) {
  const tag = orderId ? `[frontpad] #${orderId}` : '[frontpad]';
  return {
    info: (msg) => console.log(`${tag} ${msg}`),
    warn: (msg) => console.warn(`${tag} ${msg}`),
    debug: (msg) => { if (verbose) console.log(`${tag} ${msg}`); }
  };
}

async function writeLog(row) {
  const { error } = await supabase.from('frontpad_log').insert(row);
  if (error) console.error('[frontpad] could not write frontpad_log:', error.message);
}

const hideKey = (payload) => ({ ...payload, secret: '***' });

/* ── transport ────────────────────────────────────────────────────────── */

async function post(action, payload) {
  const res = await fetch(`${API}?${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(payload),
    signal: AbortSignal.timeout(20000)
  });
  const body = await res.text();
  let json = null;
  try { json = JSON.parse(body); } catch { /* reported by the caller */ }
  return { http: res.status, body, json };
}

/* ── building the order ───────────────────────────────────────────────── */

function pad(n) { return String(n).padStart(2, '0'); }

/* The service day + 1, at delivery_time — "tomorrow 10:00" in the old script,
   but counted from the day the order belongs to rather than from the moment
   it happens to be sent. */
export function deliveryDatetime(order, settings) {
  const day = order?.service_date || localDate(new Date(order?.created_at || Date.now()));
  const [y, m, d] = String(day).slice(0, 10).split('-').map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  const [hh, mm] = String(settings.delivery_time || '10:00').split(':');
  return `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())} ` +
         `${pad(Number(hh) || 0)}:${pad(Number(mm) || 0)}:00`;
}

/* Resolves every line to its article. Refuses the whole order if any line has
   none: a silently short order is worse for the kitchen than one that never
   arrived. */
async function buildPayload(order, settings, log) {
  const isReturn = order.kind === 'return';
  const column = isReturn ? 'frontpad_return_id' : 'frontpad_id';

  const lines = Array.isArray(order.items) ? order.items : [];
  const ids = [...new Set(lines.map((l) => Number(l?.id)).filter(Number.isFinite))];
  const { data: items, error } = ids.length
    ? await supabase.from('items').select(`id, item_name, ${column}`).in('id', ids)
    : { data: [] };
  if (error) throw error;
  const byId = new Map((items || []).map((i) => [i.id, i]));

  log.debug(`article map (${column}): ` +
    JSON.stringify(Object.fromEntries((items || []).map((i) => [i.item_name, i[column]]))));

  const products = [];
  const missing = [];
  for (const line of lines) {
    const item = byId.get(Number(line?.id));
    const article = item?.[column];
    const name = item?.item_name || line?.name || `#${line?.id}`;
    if (!article) { missing.push(name); continue; }
    const qty = Number(line?.qty) || 0;
    log.debug(`${isReturn ? 'return' : 'new'} «${name}» → article=${article} qty=${qty}`);
    products.push({ article: String(article), qty, name });
  }

  if (missing.length) {
    const where = isReturn ? '«Артикул возврата FrontPad»' : '«Артикул FrontPad»';
    return {
      error: `Нет артикула для: ${missing.map((n) => `«${n}»`).join(', ')} (Позиции → ${where})`
    };
  }
  if (!products.length) return { error: 'В заказе нет позиций' };

  const { data: company } = order.company_id
    ? await supabase.from('companies').select('company_name, phone').eq('id', order.company_id).maybeSingle()
    : { data: null };
  const store = company?.company_name || `Компания #${order.company_id ?? '—'}`;

  const payload = {
    secret: KEY(),
    name: store,
    descr: `${store} #${order.id}` + (isReturn ? ' (возврат)' : '') + (order.comment ? ` — ${order.comment}` : ''),
    datetime: deliveryDatetime(order, settings)
  };
  if (company?.phone) payload.phone = company.phone;
  products.forEach((p, i) => {
    payload[`product[${i}]`] = p.article;
    payload[`product_kol[${i}]`] = String(p.qty);
  });
  return { payload, products };
}

async function markOrder(orderId, patch) {
  const { error } = await supabase.from('orders').update(patch).eq('id', orderId);
  if (error) console.error(`[frontpad] #${orderId} could not save status:`, error.message);
}

/* ── the entry point ──────────────────────────────────────────────────── */

/* Sends one order. Never throws; the answer says what happened:
     { ok: true, skipped }            — nothing to do (off, return, already sent)
     { ok: true, simulated: true }    — built and logged, not sent
     { ok: true, order_id, ... }      — FrontPad accepted it
     { ok: false, error }             — refused; the caller decides what that blocks

   The outcome is also recorded on the order row (frontpad_status …).

   `inFlight` stops two clicks on «Принять» from sending the same order twice
   while the first request is still waiting on FrontPad (one server process). */
const inFlight = new Set();

export async function pushOrder(order) {
  const id = String(order?.id);
  if (inFlight.has(id)) return { ok: false, error: 'Заказ уже отправляется в FrontPad' };
  inFlight.add(id);
  try {
    return await pushOrderNow(order);
  } finally {
    inFlight.delete(id);
  }
}

async function pushOrderNow(order) {
  const settings = await frontpadSettings();
  const log = logger(order?.id, settings.verbose);

  try {
    if (!settings.enabled) {
      log.debug('skipped — integration is off');
      return { ok: true, skipped: 'disabled' };
    }
    if (order.kind === 'return' && !settings.send_returns) {
      log.debug('skipped — returns are not sent to FrontPad');
      return { ok: true, skipped: 'return' };
    }
    if (order.frontpad_status === 'sent') {
      log.warn(`skipped — already sent (FrontPad id ${order.frontpad_order_id})`);
      return { ok: true, skipped: 'already_sent' };
    }
    if (!settings.simulation && !frontpadConfigured()) {
      const error = 'FRONTPAD_APIKEY не задан на сервере';
      log.warn(error);
      await writeLog({ order_id: order.id, action: 'new_order', ok: false, error });
      return { ok: false, error };
    }

    log.info(`START kind=${order.kind} lines=${order.items?.length ?? 0}` +
             (settings.simulation ? ' [SIMULATION]' : ''));

    const built = await buildPayload(order, settings, log);
    if (built.error) {
      log.warn(`ABORT: ${built.error}`);
      await writeLog({ order_id: order.id, action: 'new_order', simulated: settings.simulation, ok: false, error: built.error });
      await markOrder(order.id, { frontpad_status: 'failed', frontpad_error: built.error });
      return { ok: false, error: built.error };
    }

    const safe = hideKey(built.payload);
    log.info(`payload=${JSON.stringify(safe)}`);

    if (settings.simulation) {
      log.info('SIMULATION — nothing was sent');
      await writeLog({ order_id: order.id, action: 'new_order', simulated: true, ok: true, request: safe });
      await markOrder(order.id, { frontpad_status: 'simulated', frontpad_error: null });
      return { ok: true, simulated: true, payload: safe };
    }

    let r;
    try {
      r = await post('new_order', built.payload);
    } catch (e) {
      const error = `FrontPad: ${e.name === 'TimeoutError' ? 'нет ответа за 20 секунд' : e.message}`;
      log.warn(`FETCH EXCEPTION: ${e.message}`);
      await writeLog({ order_id: order.id, action: 'new_order', ok: false, request: safe, error });
      await markOrder(order.id, { frontpad_status: 'failed', frontpad_error: error });
      return { ok: false, error };
    }

    log.info(`HTTP=${r.http} body=${r.body.slice(0, 1000)}`);
    const resp = r.json;
    let error = null;
    if (!r.body) error = 'FrontPad: нет ответа от сервера';
    else if (!resp) error = `FrontPad: непонятный ответ (HTTP ${r.http})`;
    else if (resp.error) error = `FrontPad: ${typeof resp.error === 'string' ? resp.error : JSON.stringify(resp.error)}`;
    else if (!resp.order_id) error = `FrontPad: в ответе нет order_id (HTTP ${r.http})`;

    if (error) {
      await writeLog({ order_id: order.id, action: 'new_order', ok: false, request: safe, http_status: r.http, response: r.body, error });
      await markOrder(order.id, { frontpad_status: 'failed', frontpad_error: error });
      return { ok: false, error };
    }

    // accepted, but FrontPad may still have dropped lines it did not recognise
    const warnings = [];
    if (resp.warnings?.invalid_product_keys) {
      const bad = Object.values(resp.warnings.invalid_product_keys)
        .map((k) => built.products[k]?.article ?? k);
      warnings.push(`FrontPad не узнал артикулы: ${bad.join(', ')}`);
    }
    if (resp.warnings?.invalid_datetime) {
      warnings.push(`FrontPad не принял дату: ${JSON.stringify(resp.warnings.invalid_datetime)}`);
    }
    warnings.forEach((w) => log.warn(`WARNING ${w}`));

    log.info(`SUCCESS order_id=${resp.order_id} order_number=${resp.order_number}`);
    await writeLog({
      order_id: order.id, action: 'new_order', ok: true, request: safe,
      http_status: r.http, response: r.body, error: warnings.join('; ') || null
    });
    await markOrder(order.id, {
      frontpad_status: 'sent',
      frontpad_order_id: String(resp.order_id),
      frontpad_order_number: resp.order_number != null ? String(resp.order_number) : null,
      frontpad_error: warnings.join('; ') || null,
      frontpad_sent_at: new Date().toISOString()
    });
    return { ok: true, order_id: resp.order_id, order_number: resp.order_number, warnings };
  } catch (e) {
    log.warn(`EXCEPTION: ${e.message}`);
    return { ok: false, error: `FrontPad: ${e.message}` };
  }
}

/* «Проверить связь»: asks FrontPad for its product list (like the old
   testFrontpadRaw) and compares it with the articles in our catalogue. Read-
   only on FrontPad's side, so it runs even in simulation mode. */
export async function testConnection() {
  if (!frontpadConfigured()) return { ok: false, error: 'FRONTPAD_APIKEY не задан на сервере' };

  let r;
  try {
    r = await post('get_products', { secret: KEY() });
  } catch (e) {
    await writeLog({ action: 'get_products', ok: false, error: e.message });
    return { ok: false, error: `FrontPad: ${e.message}` };
  }
  console.log(`[frontpad] get_products HTTP=${r.http} body=${r.body.slice(0, 1000)}`);

  const resp = r.json;
  const error = !resp ? `Непонятный ответ (HTTP ${r.http})`
    : resp.error ? String(typeof resp.error === 'string' ? resp.error : JSON.stringify(resp.error))
    : null;
  await writeLog({
    action: 'get_products', ok: !error, http_status: r.http,
    response: r.body.slice(0, 20000), error
  });
  if (error) return { ok: false, error: `FrontPad: ${error}` };

  // FrontPad answers with parallel arrays: product_id[], name[], price[]
  const known = new Set((Array.isArray(resp.product_id) ? resp.product_id : Object.values(resp.product_id || {}))
    .map((a) => String(a).trim()));

  const { data: items } = await supabase
    .from('items').select('item_name, frontpad_id, frontpad_return_id');
  const unknown = [];
  for (const i of items || []) {
    for (const col of ['frontpad_id', 'frontpad_return_id']) {
      const a = i[col];
      if (a && known.size && !known.has(String(a).trim())) {
        unknown.push({ name: i.item_name, article: a, kind: col === 'frontpad_id' ? 'order' : 'return' });
      }
    }
  }
  return { ok: true, products: known.size, unknown };
}

export async function recentLog(limit = 50) {
  const { data, error } = await supabase
    .from('frontpad_log').select('*')
    .order('created_at', { ascending: false })
    .limit(Math.min(200, Math.max(1, Number(limit) || 50)));
  if (error) throw error;
  return data;
}
