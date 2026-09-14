import { db } from './db.js';
import { esc } from './telegram.js';
import { localDate, ORDER_KINDS } from './orders.js';

/* The prep list: what the kitchen has to make for a set of orders. The
   «На кухню» button, «Отправить сейчас» on a kitchen reminder and the
   scheduled kitchen reminder all send this same text. */

/* A material is counted in pieces or weighed in kg; see materials.unit. */
const UNIT_LABEL = { pcs: 'шт.', kg: 'кг' };
export const roundQty = (n) => Math.round(n * 1000) / 1000;
const fmtQty = (n) => (Number(n) || 0).toLocaleString('ru-RU', { maximumFractionDigits: 3 });

/* What the kitchen has to make for a set of orders: the items, and the
   materials those items consume. Replacements count in full — they are cooked
   and delivered like any order, only not charged — and each item says how many
   of its units are replacements. Old return documents are left out. Materials
   live only here and in the panel; the mini-app never sees them. */
export async function summarise(ids) {
  const { data: orders, error } = await db
    .from('orders').select('id, kind, items, total').in('id', ids);
  if (error) throw error;

  const prep = (orders || []).filter((o) => ORDER_KINDS.includes(o.kind));

  // item id -> units to make, and how many of those are replacements
  const itemQty = new Map();
  const replacedQty = new Map();
  for (const o of prep) {
    for (const line of Array.isArray(o.items) ? o.items : []) {
      const id = Number(line.id);
      if (!Number.isFinite(id)) continue;
      const qty = Number(line.qty) || 0;
      itemQty.set(id, (itemQty.get(id) || 0) + qty);
      if (o.kind === 'replacement') replacedQty.set(id, (replacedQty.get(id) || 0) + qty);
    }
  }

  const { data: catalog, error: cErr } = await db
    .from('items').select('id, item_name, materials').in('id', [...itemQty.keys()]);
  if (cErr) throw cErr;

  const byId = new Map((catalog || []).map((i) => [i.id, i]));
  const { data: allMaterials } = await db.from('materials').select('id, material_name, cost, unit');
  const matById = new Map((allMaterials || []).map((m) => [m.id, m]));

  const items = [];
  const materials = new Map();   // material id -> { name, qty, cost, unit }

  for (const [id, qty] of itemQty) {
    const item = byId.get(id);
    items.push({ id, name: item?.item_name || `#${id}`, qty, replaced: replacedQty.get(id) || 0 });

    for (const m of Array.isArray(item?.materials) ? item.materials : []) {
      const meta = matById.get(Number(m.id));
      const need = (Number(m.qty) || 1) * qty;
      const cur = materials.get(m.id) ||
        { id: m.id, name: meta?.material_name || m.name || `#${m.id}`, qty: 0,
          cost: meta?.cost ?? 0, unit: meta?.unit === 'kg' ? 'kg' : 'pcs' };
      cur.qty += need;
      materials.set(m.id, cur);
    }
  }

  // weights add up in float, so both the amount and the money are settled
  // here, once, rather than in every place that prints them
  const list = [...materials.values()]
    .map((m) => ({ ...m, qty: roundQty(m.qty), total: Math.round(m.qty * (m.cost || 0)) }))
    .sort((a, b) => a.name.localeCompare(b.name, 'ru'));

  return {
    order_count: prep.filter((o) => o.kind === 'order').length,
    replacement_count: prep.filter((o) => o.kind === 'replacement').length,
    items: items.sort((a, b) => a.name.localeCompare(b.name, 'ru')),
    materials: list,
    materials_total: list.reduce((a, m) => a + m.total, 0)
  };
}

/* Настройки → Себестоимость сырья. On unless switched off; off, no material
   cost is printed anywhere. */
export async function useMaterialCost() {
  const { data } = await db
    .from('app_settings').select('value').eq('key', 'materials').maybeSingle();
  return data?.value?.use_cost !== false;
}

/* The prep list as the kitchen group reads it. */
export function kitchenText(summary, { cost = true } = {}) {
  const when = new Date().toLocaleString('ru-RU', {
    timeZone: 'Europe/Chisinau', dateStyle: 'short', timeStyle: 'short'
  });

  return [
    '<b>Список на приготовление</b>',
    `Заказов: ${summary.order_count}` +
      (summary.replacement_count ? `, замен: ${summary.replacement_count}` : ''),
    '',
    '<b>Позиции</b>',
    ...summary.items.map((i) =>
      `• ${esc(i.name)} — ${i.qty} шт.` + (i.replaced ? ` (из них замена ${i.replaced})` : '')),
    '',
    '<b>Сырьё</b>',
    ...summary.materials.map((m) => `• ${esc(m.name)} — ${fmtQty(m.qty)} ${UNIT_LABEL[m.unit] || 'шт.'}`),
    '',
    ...(cost ? [`Себестоимость сырья: <b>${summary.materials_total} ₽</b>`] : []),
    `<i>отправлено ${when}</i>`
  ].join('\n');
}

/* The day's confirmed orders and replacements — what a kitchen reminder makes
   its list from, whether it is sent by hand or by the schedule. */
export async function confirmedOrderIds(day = localDate()) {
  const { data, error } = await db
    .from('orders').select('id')
    .eq('status', 'confirmed').in('kind', ORDER_KINDS).eq('service_date', day);
  if (error) throw error;
  return (data || []).map((o) => o.id);
}
