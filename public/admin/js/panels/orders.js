import { api } from '../api.js';
import { h, esc, toast, confirmDialog, fmtDate } from '../ui.js';
import { paintIcons } from '../icons.js';

/* Only the date range costs a request. Status, type and company narrow the
   rows already in memory, so those dropdowns react instantly. */

let rows = [];
let companies = [];
let focusId = null;
let root;

const today = () => new Date().toISOString().slice(0, 10);

const filters = {
  from: today(),
  to: today(),
  status: 'new',
  kind: 'all',
  company: ''        // free text: matches the company name, empty = all
};

const KIND = { order: 'Заказ', return: 'Возврат' };
const STATUS = {
  new: ['Новый', 'pill--warn'],
  confirmed: ['Подтверждён', 'pill--on'],
  rejected: ['Отклонён', 'pill--off']
};

/* Local midnight, not UTC: "today" has to mean the admin's today. */
const dayStart = (d) => new Date(`${d}T00:00:00`).toISOString();
const dayEnd = (d) => new Date(`${d}T23:59:59.999`).toISOString();

export const ordersPanel = {
  id: 'orders',
  label: 'Заказы',
  icon: 'orders',
  title: 'Заказы',
  subtitle: 'Заказы и возвраты компаний',

  actions: () => [
    h(`<button class="btn btn--ghost btn--icon" id="ord-refresh" title="Обновить"><span data-icon="refresh"></span></button>`)
  ],

  async render(container, params = {}) {
    root = container;
    focusId = params.focus || null;

    // A deep link from Telegram must land on its order whatever the filters
    // would otherwise hide, so open it unfiltered.
    if (focusId) {
      filters.from = '';
      filters.to = '';
      filters.status = 'all';
      filters.kind = 'all';
      filters.company = '';
    }

    root.append(h(`
      <div class="card">
        <div class="card__head toolbar" id="ord-toolbar"></div>
        <div id="ord-wrap"></div>
      </div>`));

    document.getElementById('ord-refresh')?.addEventListener('click', load);
    drawToolbar();
    await load();
  }
};

async function load() {
  try {
    const qs = new URLSearchParams();
    if (filters.from) qs.set('from', dayStart(filters.from));
    if (filters.to) qs.set('to', dayEnd(filters.to));

    const [orders, comps] = await Promise.all([
      api.get(`/api/admin/orders${qs.toString() ? `?${qs}` : ''}`),
      companies.length ? Promise.resolve(companies) : api.get('/api/admin/companies')
    ]);
    rows = orders;
    companies = comps;
    drawToolbar();
    draw();
  } catch (e) {
    toast(e.message, 'err');
  }
}

function drawToolbar() {
  const bar = root?.querySelector('#ord-toolbar');
  if (!bar) return;

  bar.innerHTML = `
    <label class="tool">
      <span class="tool__label">С</span>
      <input class="input input--sm" type="date" id="f-from" value="${filters.from}">
    </label>
    <label class="tool">
      <span class="tool__label">По</span>
      <input class="input input--sm" type="date" id="f-to" value="${filters.to}">
    </label>
    <button class="btn btn--sm" id="f-today">Сегодня</button>
    <button class="btn btn--sm" id="f-all-time">Всё время</button>

    <span class="toolbar__sep"></span>

    <button class="btn btn--sm" id="b-export-orders">Заказы CSV</button>
    <button class="btn btn--sm" id="b-export-returns">Возвраты CSV</button>
    <button class="btn btn--sm" id="b-export-materials">Материалы CSV</button>
    <button class="btn btn--sm btn--primary" id="b-send-kitchen">На кухню</button>

    <div style="flex:1 1 auto"></div>

    <select class="input input--sm" id="f-status" title="Статус">
      <option value="new"       ${filters.status === 'new' ? 'selected' : ''}>Новые</option>
      <option value="confirmed" ${filters.status === 'confirmed' ? 'selected' : ''}>Подтверждённые</option>
      <option value="rejected"  ${filters.status === 'rejected' ? 'selected' : ''}>Отклонённые</option>
      <option value="all"       ${filters.status === 'all' ? 'selected' : ''}>Все статусы</option>
    </select>

    <select class="input input--sm" id="f-kind" title="Тип">
      <option value="all"    ${filters.kind === 'all' ? 'selected' : ''}>Все типы</option>
      <option value="order"  ${filters.kind === 'order' ? 'selected' : ''}>Заказы</option>
      <option value="return" ${filters.kind === 'return' ? 'selected' : ''}>Возвраты</option>
    </select>

    <input class="input input--sm" id="f-company" list="company-options"
           placeholder="Все компании" value="${esc(filters.company)}" title="Компания">
    <datalist id="company-options">
      ${companies.map((c) => `<option value="${esc(c.company_name || `#${c.id}`)}"></option>`).join('')}
    </datalist>`;

  // dates need a round trip; the rest filter what is already loaded
  bar.querySelector('#f-from').onchange = (e) => { filters.from = e.target.value; load(); };
  bar.querySelector('#f-to').onchange = (e) => { filters.to = e.target.value; load(); };
  bar.querySelector('#f-today').onclick = () => {
    filters.from = filters.to = today();
    load();
  };
  bar.querySelector('#f-all-time').onclick = () => {
    filters.from = filters.to = '';
    load();
  };
  bar.querySelector('#f-status').onchange = (e) => { filters.status = e.target.value; draw(); };
  bar.querySelector('#f-kind').onchange = (e) => { filters.kind = e.target.value; draw(); };
  // typed, not picked: filter as they go rather than only on change
  bar.querySelector('#f-company').oninput = (e) => { filters.company = e.target.value; draw(); };

  bar.querySelector('#b-export-orders').onclick = () => exportOrders('order');
  bar.querySelector('#b-export-returns').onclick = () => exportOrders('return');
  bar.querySelector('#b-export-materials').onclick = exportMaterials;
  bar.querySelector('#b-send-kitchen').onclick = sendToKitchen;
}

function visible() {
  return rows.filter((o) =>
    (filters.status === 'all' || o.status === filters.status) &&
    (filters.kind === 'all' || o.kind === filters.kind) &&
    (!filters.company.trim() ||
      String(o.companies?.company_name || '').toLowerCase()
        .includes(filters.company.trim().toLowerCase())));
}

function draw() {
  const wrap = root?.querySelector('#ord-wrap');
  if (!wrap) return;

  const list = visible();
  if (!list.length) {
    wrap.innerHTML = `<div class="card__body" style="color:var(--ink-3)">
      ${rows.length ? 'Под фильтры ничего не подходит.' : 'За выбранный период заказов нет.'}
    </div>`;
    return;
  }

  wrap.innerHTML = `
    <table class="table">
      <thead><tr>
        <th style="width:70px">№</th><th style="width:110px">Тип</th>
        <th style="width:180px">Компания</th><th style="width:150px">Заказал</th>
        <th>Позиции</th><th style="width:100px">Итого</th>
        <th style="width:130px">Статус</th><th style="width:150px">Создан</th>
        <th style="width:220px"></th>
      </tr></thead>
      <tbody>${list.map(rowHTML).join('')}</tbody>
    </table>`;

  wrap.querySelectorAll('[data-decide]').forEach((b) => {
    b.onclick = () => decide(b.dataset.decide, b.dataset.status);
  });
  wrap.querySelectorAll('[data-invoice]').forEach((b) => {
    b.onclick = () => printInvoice(b.dataset.invoice);
  });

  paintIcons(wrap);
  applyFocus();
}

function rowHTML(o) {
  const [label, cls] = STATUS[o.status] || [o.status, ''];
  const lines = Array.isArray(o.items) ? o.items : [];
  return `
    <tr id="order-row-${o.id}">
      <td class="num">${o.id}</td>
      <td><span class="pill ${o.kind === 'return' ? 'pill--off' : ''}">${KIND[o.kind] || o.kind}</span></td>
      <td style="font-weight:700">${esc(o.companies?.company_name || '—')}</td>
      <td>${esc(o.users?.user_name || '—')}</td>
      <td>${lines.length
        ? lines.map((l) => `<span class="chip">${esc(l.name)} <span class="chip__qty">&times;${l.qty}</span></span>`).join(' ')
        : '<span style="color:var(--ink-3)">—</span>'}
        ${o.comment ? `<div class="hint" style="margin:4px 0 0">${esc(o.comment)}</div>` : ''}</td>
      <td class="num">${o.total ?? 0} ₽</td>
      <td><span class="pill ${cls}">${esc(label)}</span></td>
      <td class="num">${fmtDate(o.created_at)}</td>
      <td><div class="row-actions">
        ${o.status === 'new' ? `
          <button class="btn btn--sm btn--primary" data-decide="${o.id}" data-status="confirmed">Принять</button>
          <button class="btn btn--sm" data-decide="${o.id}" data-status="rejected">Отклонить</button>` : ''}
        <button class="btn btn--ghost btn--icon btn--sm" data-invoice="${o.id}" title="Печать накладной"><span data-icon="print"></span></button>
      </div></td>
    </tr>`;
}

function decide(id, status) {
  const order = rows.find((r) => String(r.id) === String(id));
  const verb = status === 'confirmed' ? 'Подтвердить' : 'Отклонить';
  confirmDialog(
    `${verb} заказ #${id}`,
    `${verb} ${KIND[order?.kind] || 'заказ'} на ${order?.total ?? 0} ₽? ` +
    'Заказчик получит уведомление в Telegram.',
    async () => {
      await api.post(`/api/admin/orders/${id}/decide`, { status });
      toast(status === 'confirmed' ? 'Заказ подтверждён' : 'Заказ отклонён');
      await load();
    },
    verb
  );
}

/* Arriving from the Telegram button. */
function applyFocus() {
  if (!focusId) return;
  const row = root?.querySelector(`#order-row-${CSS.escape(focusId)}`);
  if (!row) {
    toast('Заказ не найден', 'err');
    focusId = null;
    return;
  }
  focusId = null;
  row.scrollIntoView({ behavior: 'smooth', block: 'center' });
  row.classList.remove('row-flash');
  void row.offsetWidth;
  row.classList.add('row-flash');
}


/* ── export / kitchen ───────────────────────────────────────── */

/* Excel on a Russian locale reads ';' as the separator and needs the BOM to
   detect UTF-8; without both, Cyrillic arrives as mojibake in one column. */
function downloadCsv(name, rowsOut) {
  const body = rowsOut
    .map((r) => r.map((cell) => {
      const v = String(cell ?? '');
      return /[";\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
    }).join(';'))
    .join('\r\n');

  const blob = new Blob([`﻿${body}`], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${name}_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function exportOrders(kind) {
  const list = visible().filter((o) => o.kind === kind);
  if (!list.length) {
    return toast(kind === 'return' ? 'Возвратов в выборке нет' : 'Заказов в выборке нет', 'err');
  }

  const out = [['№', 'Тип', 'Компания', 'Заказал', 'Позиция', 'Кол-во', 'Цена', 'Сумма', 'Статус', 'Создан']];
  for (const o of list) {
    const lines = Array.isArray(o.items) ? o.items : [];
    // one row per line so the file pivots cleanly in a spreadsheet
    if (!lines.length) {
      out.push([o.id, KIND[o.kind], o.companies?.company_name || '', o.users?.user_name || '',
                '', '', '', o.total ?? 0, STATUS[o.status]?.[0] || o.status, fmtDate(o.created_at)]);
      continue;
    }
    for (const l of lines) {
      out.push([o.id, KIND[o.kind], o.companies?.company_name || '', o.users?.user_name || '',
                l.name, l.qty, l.cost, l.cost * l.qty,
                STATUS[o.status]?.[0] || o.status, fmtDate(o.created_at)]);
    }
  }
  downloadCsv(kind === 'return' ? 'vozvraty' : 'zakazy', out);
  toast(`Выгружено: ${list.length}`);
}

function selectedIds() {
  return visible().map((o) => o.id);
}

async function exportMaterials() {
  const ids = selectedIds();
  if (!ids.length) return toast('В выборке нет заказов', 'err');

  try {
    const s = await api.post('/api/admin/orders/summary', { ids });
    if (!s.materials.length) return toast('Материалы не заданы у позиций', 'err');

    const out = [['Материал', 'Количество', 'Себестоимость', 'Сумма']];
    s.materials.forEach((m) => out.push([m.name, m.qty, m.cost, m.total]));
    out.push([]);
    out.push(['Итого', '', '', s.materials_total]);
    out.push([]);
    out.push(['Позиция', 'К приготовлению']);
    s.items.forEach((i) => out.push([i.name, i.qty]));

    downloadCsv('materialy', out);
    toast(`Материалов: ${s.materials.length}`);
  } catch (e) {
    toast(e.message, 'err');
  }
}

function sendToKitchen() {
  const ids = selectedIds();
  if (!ids.length) return toast('В выборке нет заказов', 'err');

  confirmDialog(
    'Отправить на кухню',
    `Отправить список на приготовление по ${ids.length} заказам в группу кухни?`,
    async () => {
      const s = await api.post('/api/admin/orders/send-kitchen', { ids });
      toast(`Отправлено: ${s.items.length} позиций`);
    },
    'Отправить'
  );
}

function printInvoice(id) {
  // The real накладная waits on the blank the client will supply.
  toast(`Накладная для заказа #${id} — шаблон ещё не готов`);
}
