import { supabase } from './supabase.js';

/* When a customer may still change an order, and whether the shop is taking
   new ones at all. Two independent questions, settled by two groups of
   settings:

   Permissions — may a customer touch an order the kitchen has already
   approved (`allow_edit_confirmed`), and may they cancel one nobody has
   approved yet (`allow_delete_new`).

   The daily time limit — off by default. Switched on it names one wall-clock
   time (`cutoff_time`) that can close editing for the day
   (`lock_after_cutoff`) and decides what becomes of orders placed after it
   (`after_cutoff`): they either roll onto tomorrow's list or are refused
   until the shop reopens (`resume_time`).

   Both the mini-app (which greys its buttons out) and the endpoints (which
   refuse) read the answer from here, so an app left open since before the
   cutoff behaves exactly like one opened after it. */

export const TZ = 'Europe/Chisinau';

export const ORDER_DEFAULTS = {
  allow_edit_confirmed: false,
  allow_delete_new: false,
  // returns are composed freely from the catalogue, or only against a past
  // order — see returnableFrom() below
  returns_from_history: false,
  cutoff_enabled: false,
  cutoff_time: '22:00',
  lock_after_cutoff: true,
  after_cutoff: 'next_day',   // next_day | block
  resume_time: '08:00'
};

export async function orderSettings() {
  const { data } = await supabase
    .from('app_settings').select('value').eq('key', 'orders').maybeSingle();
  return { ...ORDER_DEFAULTS, ...(data?.value || {}) };
}

/* ── local wall clock ───────────────────────────────────────────────────
   The cutoff is "22:00 here", not an instant, so the day it belongs to and
   the offset in force on that day both have to come from the zone rather
   than from the server's own clock. */

const FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ, hour12: false,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit'
});

function localParts(date) {
  const out = {};
  for (const p of FMT.formatToParts(date)) {
    if (p.type !== 'literal') out[p.type] = Number(p.value);
  }
  if (out.hour === 24) out.hour = 0;      // some engines report midnight as 24
  return out;
}

const offsetAt = (date) => {
  const p = localParts(date);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - date.getTime();
};

/* The instant of a wall-clock time on a local calendar day. Guessing with the
   offset in force at the guess and correcting once is enough: only a DST
   switch moves it, and one correction lands on the right side of it. */
function instantAt(y, m, d, hh, mm) {
  const wall = Date.UTC(y, m - 1, d, hh, mm);
  const guess = new Date(wall - offsetAt(new Date(wall)));
  return new Date(wall - offsetAt(guess));
}

export const localDate = (date = new Date()) => {
  const p = localParts(date);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
};

export function parseTime(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim());
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (hh > 23 || mm > 59) return null;
  return { hh, mm, text: `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}` };
}

/* `isoDay` is 'YYYY-MM-DD'; days is a shift in calendar days. */
function timeOn(isoDay, time, days = 0) {
  const t = parseTime(time);
  if (!t) return null;
  const [y, m, d] = isoDay.split('-').map(Number);
  return instantAt(y, m, d + days, t.hh, t.mm);
}

/* ── the rules ─────────────────────────────────────────────────────────── */

/* The day an order counts for: its own if it arrived before the cutoff, the
   next one if it arrived after. Stored on the row at insert so the answer
   never changes afterwards, least of all when the cutoff is moved. */
export function serviceDateFor(settings, now = new Date()) {
  const today = localDate(now);
  if (!settings?.cutoff_enabled) return today;

  const cutoff = timeOn(today, settings.cutoff_time);
  if (!cutoff || now < cutoff) return today;
  return localDate(new Date(cutoff.getTime() + 24 * 3600 * 1000));
}

/* Editing closes at the cutoff of the day the order counts for — but only
   when the time limit is set to lock the day. Without one there is no
   deadline, and what an order allows depends on its status alone. */
export function editDeadline(order, settings) {
  if (!settings?.cutoff_enabled || settings.lock_after_cutoff === false) return null;
  const day = order?.service_date || localDate(new Date(order.created_at));
  return timeOn(day, settings.cutoff_time);
}

/* Which statuses a customer may still edit. Rejected is always final: there
   is nothing left to change. */
export function editableStatuses(settings) {
  return settings?.allow_edit_confirmed ? ['new', 'confirmed'] : ['new'];
}

export function canEdit(order, settings, now = new Date()) {
  if (!editableStatuses(settings).includes(order.status)) return false;
  const deadline = editDeadline(order, settings);
  return !deadline || now < deadline;
}

/* Cancelling is only ever offered before approval, however editing is set. */
export function canDelete(order, settings, now = new Date()) {
  return Boolean(settings?.allow_delete_new) &&
    order.status === 'new' &&
    canEdit(order, settings, now);
}

/* Whether new orders are being accepted right now. Only 'block' ever closes
   the door; under 'next_day' the order simply lands on tomorrow. The blocked
   stretch runs from one day's cutoff to the next morning's resume time. */
export function orderingWindow(settings, now = new Date()) {
  const open = { blocked: false, resumes_at: null, service_date: serviceDateFor(settings, now) };
  if (!settings?.cutoff_enabled || settings.after_cutoff !== 'block') return open;

  const today = localDate(now);
  const cutoffToday = timeOn(today, settings.cutoff_time);
  if (!cutoffToday) return open;

  // after tonight's cutoff: closed until tomorrow morning
  if (now >= cutoffToday) {
    const resume = timeOn(today, settings.resume_time, 1);
    return { blocked: true, resumes_at: resume, service_date: open.service_date };
  }

  // before it, but possibly still inside last night's stretch
  const resumeToday = timeOn(today, settings.resume_time);
  if (resumeToday && now < resumeToday && timeOn(today, settings.cutoff_time, -1) <= now) {
    return { blocked: true, resumes_at: resumeToday, service_date: open.service_date };
  }
  return open;
}

/* Prices the basket from the database — the browser sends ids and quantities
   and nothing about cost, on an edit and a repeat exactly as on a first
   submit. */
/* `forOrder` applies the availability rule: an item taken off the list can
   still be returned, so only a new order is refused. Blocked names come back
   rather than being dropped quietly — a basket filled before the item was
   switched off has to say why it cannot be sent. */
export async function priceLines(wanted, { forOrder = false } = {}) {
  const ids = [...new Set((wanted || []).map((l) => Number(l?.id)).filter(Number.isFinite))];
  if (!ids.length) return { lines: [], total: 0, blocked: [] };

  const { data: known, error } = await supabase
    .from('items').select('id, item_name, item_cost, available').in('id', ids);
  if (error) throw error;

  const byId = new Map((known || []).map((i) => [i.id, i]));
  const lines = [];
  const blocked = [];
  for (const line of wanted) {
    const item = byId.get(Number(line?.id));
    if (!item) continue;
    if (forOrder && item.available === false) {
      blocked.push(item.item_name || `#${item.id}`);
      continue;
    }
    const qty = Math.min(999, Math.max(1, Math.round(Number(line?.qty)) || 1));
    lines.push({ id: item.id, name: item.item_name, cost: item.item_cost ?? 0, qty });
  }
  return { lines, total: lines.reduce((acc, l) => acc + l.cost * l.qty, 0), blocked };
}

/* ── returns against a past order ──────────────────────────────────────
   Under `returns_from_history` a return is not composed from the catalogue
   but picked out of an order that was actually placed. What is still
   returnable is that order's lines less everything already sent back against
   it, so the same portion cannot be returned twice over several attempts.

   Lines are priced from the order's own snapshot, not from today's catalogue:
   the customer is sending back what they bought, at what they were charged. */

/* Returns null when the order is not one this company may return against. */
export async function returnableFrom(orderId, companyId) {
  const { data: order, error } = await supabase
    .from('orders')
    .select('id, company_id, kind, status, items, created_at, service_date')
    .eq('id', orderId)
    .maybeSingle();
  if (error) throw error;

  if (!order) return null;
  if (String(order.company_id) !== String(companyId)) return null;
  if (order.kind !== 'order') return null;          // you cannot return a return
  if (order.status === 'rejected') return null;     // never delivered

  const { data: prior, error: pErr } = await supabase
    .from('orders')
    .select('items')
    .eq('source_order_id', orderId)
    .neq('status', 'rejected');
  if (pErr) throw pErr;

  const used = new Map();
  for (const r of prior || []) {
    for (const l of Array.isArray(r.items) ? r.items : []) {
      const id = Number(l.id);
      used.set(id, (used.get(id) || 0) + (Number(l.qty) || 0));
    }
  }

  const lines = (Array.isArray(order.items) ? order.items : []).map((l) => {
    const id = Number(l.id);
    const qty = Number(l.qty) || 0;
    return {
      id,
      name: l.name,
      cost: Number(l.cost) || 0,
      qty,
      left: Math.max(0, qty - (used.get(id) || 0))
    };
  });

  return { order, lines };
}

/* Prices a basket against what is still returnable. Refuses rather than
   trimming: a customer who asked for three back should not silently get one. */
export function priceReturn(wanted, returnable) {
  const byId = new Map(returnable.lines.map((l) => [l.id, l]));
  const lines = [];
  const over = [];

  for (const w of wanted || []) {
    const src = byId.get(Number(w?.id));
    if (!src) continue;                       // not part of that order
    const qty = Math.max(1, Math.round(Number(w?.qty)) || 1);
    if (qty > src.left) { over.push(src.name); continue; }
    lines.push({ id: src.id, name: src.name, cost: src.cost, qty });
  }

  return { lines, total: lines.reduce((a, l) => a + l.cost * l.qty, 0), over };
}

export function overMessage(names) {
  return names.length === 1
    ? `«${names[0]}» — столько вернуть нельзя`
    : `Столько вернуть нельзя: ${names.map((n) => `«${n}»`).join(', ')}`;
}

/* The same sentence from both the create and the edit path. */
export function blockedMessage(names) {
  return names.length === 1
    ? `«${names[0]}» больше не принимается к заказу`
    : `Эти позиции больше не принимаются к заказу: ${names.map((n) => `«${n}»`).join(', ')}`;
}
