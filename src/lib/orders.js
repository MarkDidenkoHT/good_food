import { supabase } from './supabase.js';

/* When a customer may still change an order, and whether the shop is taking
   new ones at all. One cutoff time a day: before it, an order nobody has
   approved yet is freely editable; after it the day's orders have gone into
   production and are closed.

   Both the mini-app (which greys its buttons out) and the endpoints (which
   refuse) read the answer from here, so an app left open since before the
   cutoff behaves exactly like one opened after it. */

export const TZ = 'Europe/Chisinau';

export const ORDER_DEFAULTS = {
  cutoff_enabled: false,
  cutoff_time: '22:00',
  after_cutoff: 'next_day',   // next_day | block
  resume_time: '08:00',
  allow_delete_new: false
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

/* Editing closes at the cutoff of the day the order counts for. With no
   cutoff configured there is no deadline — only approval closes an order. */
export function editDeadline(order, settings) {
  if (!settings?.cutoff_enabled) return null;
  const day = order?.service_date || localDate(new Date(order.created_at));
  return timeOn(day, settings.cutoff_time);
}

export function canEdit(order, settings, now = new Date()) {
  if (order.status !== 'new') return false;      // approved or rejected is final
  const deadline = editDeadline(order, settings);
  return !deadline || now < deadline;
}

export function canDelete(order, settings, now = new Date()) {
  return Boolean(settings?.allow_delete_new) && canEdit(order, settings, now);
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
