import { api } from '../api.js';
import { h, esc, toast, fmtDate } from '../ui.js';
import { paintIcons } from '../icons.js';
import { showLoader } from '/loader.js';

/* Only the date range costs a request. Status, the sub-tab, the search and
   the sort all work on the orders already in memory. */

let orders = [];
let companies = [];
let items = [];
let root;
let tab = 'companies';
let query = '';

/* Local dates, not UTC: the range has to mean the admin's days. */
const ymd = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const today = () => ymd(new Date());
const monthStart = () => { const d = new Date(); d.setDate(1); return ymd(d); };
const daysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return ymd(d); };

const filters = {
  from: monthStart(),
  to: today(),
  status: 'confirmed'   // confirmed | open (all but rejected) | all
};

const sort = {
  companies: { key: 'net', dir: -1 },
  items: { key: 'soldQty', dir: -1 }
};

const dayStart = (d) => new Date(`${d}T00:00:00`).toISOString();
const dayEnd = (d) => new Date(`${d}T23:59:59.999`).toISOString();

function statsUrl() {
  const qs = new URLSearchParams();
  if (filters.from) qs.set('from', dayStart(filters.from));
  if (filters.to) qs.set('to', dayEnd(filters.to));
  return `/api/admin/stats${qs.toString() ? `?${qs}` : ''}`;
}

const money = (n) => `${Math.round(n || 0).toLocaleString('ru-RU')} ₽`;
const int = (n) => (n || 0).toLocaleString('ru-RU');
const pct = (n) => `${(n * 100).toLocaleString('ru-RU', { maximumFractionDigits: 1 })}%`;

export const statsPanel = {
  id: 'stats',
  label: 'Статистика',
  icon: 'stats',
  title: 'Статистика',
  subtitle: 'Продажи по компаниям и позициям',

  actions: () => [
    h(`<button class="btn btn--ghost btn--icon" id="st-refresh" title="Обновить"><span data-icon="refresh"></span></button>`)
  ],

  preload: () => [statsUrl(), '/api/admin/companies', '/api/admin/items'],

  async render(container) {
    root = container;
    root.append(h(`
      <div>
        <div class="card" style="margin-bottom:16px">
          <div class="card__head toolbar" id="st-toolbar"></div>
          <div class="kpis" id="st-kpis"></div>
        </div>
        <div class="card">
          <div class="card__head">
            <div class="subtabs" id="st-tabs" role="tablist"></div>
            <div style="flex:1 1 auto"></div>
            <div style="position:relative;width:260px">
              <input class="input" id="st-search" placeholder="Поиск" style="padding-left:34px">
              <span data-icon="search" style="position:absolute;left:10px;top:9px;width:18px;height:18px;color:var(--ink-3)"></span>
            </div>
          </div>
          <div id="st-wrap" style="overflow-x:auto"></div>
        </div>
      </div>`));

    const search = root.querySelector('#st-search');
    search.value = query;
    search.oninput = () => { query = search.value; drawTable(); };

    document.getElementById('st-refresh')?.addEventListener('click', () => load(true));
    drawToolbar();
    await load();
  }
};

async function load(fresh = false) {
  showLoader(root?.querySelector('#st-wrap'), { size: 'sm', count: 4 });
  try {
    [orders, companies, items] = await Promise.all([
      api.get(statsUrl(), { fresh }),
      api.get('/api/admin/companies', { fresh }),
      api.get('/api/admin/items', { fresh })
    ]);
    draw();
  } catch (e) {
    toast(e.message, 'err');
  }
}

function drawToolbar() {
  const bar = root?.querySelector('#st-toolbar');
  if (!bar) return;

  bar.innerHTML = `
    <label class="tool">
      <span class="tool__label">С</span>
      <input class="input input--sm" type="date" id="s-from" value="${filters.from}">
    </label>
    <label class="tool">
      <span class="tool__label">По</span>
      <input class="input input--sm" type="date" id="s-to" value="${filters.to}">
    </label>
    <button class="btn btn--sm" data-range="7">7 дней</button>
    <button class="btn btn--sm" data-range="30">30 дней</button>
    <button class="btn btn--sm" data-range="month">Этот месяц</button>
    <button class="btn btn--sm" data-range="all">Всё время</button>

    <div style="flex:1 1 auto"></div>

    <select class="input input--sm" id="s-status" title="Какие заказы считать">
      <option value="confirmed" ${filters.status === 'confirmed' ? 'selected' : ''}>Только подтверждённые</option>
      <option value="open"      ${filters.status === 'open' ? 'selected' : ''}>Все, кроме отклонённых</option>
      <option value="all"       ${filters.status === 'all' ? 'selected' : ''}>Все статусы</option>
    </select>`;

  const setRange = (from, to) => {
    filters.from = from;
    filters.to = to;
    drawToolbar();
    load();
  };

  bar.querySelector('#s-from').onchange = (e) => { filters.from = e.target.value; load(); };
  bar.querySelector('#s-to').onchange = (e) => { filters.to = e.target.value; load(); };
  bar.querySelectorAll('[data-range]').forEach((b) => {
    b.onclick = () => {
      const r = b.dataset.range;
      if (r === 'all') setRange('', '');
      else if (r === 'month') setRange(monthStart(), today());
      else setRange(daysAgo(Number(r) - 1), today());
    };
  });
  bar.querySelector('#s-status').onchange = (e) => { filters.status = e.target.value; draw(); };

  paintIcons(bar);
}

/* ── aggregation ────────────────────────────────────────────── */

function counted() {
  return orders.filter((o) =>
    filters.status === 'all' ||
    (filters.status === 'confirmed' ? o.status === 'confirmed' : o.status !== 'rejected'));
}

function companyRows(list) {
  const names = new Map(companies.map((c) => [c.id, c.company_name]));
  const by = new Map();
  for (const o of list) {
    const key = o.company_id ?? 'none';
    let r = by.get(key);
    if (!r) {
      r = {
        name: o.company_id == null ? 'Без компании' : names.get(o.company_id) || `#${o.company_id}`,
        orders: 0, revenue: 0, returns: 0, returned: 0, last: null, users: new Set()
      };
      by.set(key, r);
    }
    const sum = Number(o.total) || 0;
    if (o.kind === 'return') { r.returns++; r.returned += sum; }
    else {
      r.orders++;
      r.revenue += sum;
      if (!r.last || o.created_at > r.last) r.last = o.created_at;
    }
    if (o.user_id != null) r.users.add(o.user_id);
  }

  const rows = [...by.values()];
  const totalNet = rows.reduce((a, r) => a + r.revenue - r.returned, 0);
  return rows.map((r) => ({
    ...r,
    users: r.users.size,
    net: r.revenue - r.returned,
    avg: r.orders ? r.revenue / r.orders : 0,
    share: totalNet > 0 ? (r.revenue - r.returned) / totalNet : 0
  }));
}

function itemRows(list) {
  const byId = new Map(items.map((i) => [i.id, i]));
  const by = new Map();
  for (const o of list) {
    const lines = Array.isArray(o.items) ? o.items : [];
    for (const l of lines) {
      const key = l.id ?? `name:${l.name}`;
      let r = by.get(key);
      if (!r) {
        const it = byId.get(l.id);
        r = {
          name: it?.item_name || l.name || '—',
          category: it?.item_category || '',
          soldQty: 0, revenue: 0, returnedQty: 0, returned: 0,
          orders: new Set(), companies: new Set()
        };
        by.set(key, r);
      }
      const qty = Number(l.qty) || 0;
      const sum = qty * (Number(l.cost) || 0);
      if (o.kind === 'return') { r.returnedQty += qty; r.returned += sum; }
      else {
        r.soldQty += qty;
        r.revenue += sum;
        r.orders.add(o.id);
        if (o.company_id != null) r.companies.add(o.company_id);
      }
    }
  }
  return [...by.values()].map((r) => ({
    ...r,
    orders: r.orders.size,
    companies: r.companies.size,
    net: r.revenue - r.returned,
    returnRate: r.soldQty ? r.returnedQty / r.soldQty : 0
  }));
}

/* ── drawing ────────────────────────────────────────────────── */

function draw() {
  const list = counted();
  drawKpis(list);
  drawTabs(list);
  drawTable();
}

function drawKpis(list) {
  const box = root?.querySelector('#st-kpis');
  if (!box) return;

  const ords = list.filter((o) => o.kind !== 'return');
  const rets = list.filter((o) => o.kind === 'return');
  const revenue = ords.reduce((a, o) => a + (Number(o.total) || 0), 0);
  const returned = rets.reduce((a, o) => a + (Number(o.total) || 0), 0);
  const active = new Set(ords.map((o) => o.company_id).filter((id) => id != null)).size;
  const pending = orders.filter((o) => o.status === 'new').length;

  const kpi = (label, value, note = '') => `
    <div class="kpi">
      <div class="kpi__label">${label}</div>
      <div class="kpi__value">${value}</div>
      ${note ? `<div class="kpi__note">${note}</div>` : ''}
    </div>`;

  box.innerHTML =
    kpi('Заказов', int(ords.length), pending && filters.status === 'confirmed' ? `ещё ${int(pending)} ждут решения` : '') +
    kpi('Выручка', money(revenue)) +
    kpi('Возвраты', money(returned), `${int(rets.length)} шт · ${revenue ? pct(returned / revenue) : '0%'}`) +
    kpi('Чистая выручка', money(revenue - returned)) +
    kpi('Средний чек', money(ords.length ? revenue / ords.length : 0)) +
    kpi('Активных компаний', int(active), `из ${int(companies.length)}`);
}

function drawTabs(list) {
  const bar = root?.querySelector('#st-tabs');
  if (!bar) return;
  const defs = [
    ['companies', `Компании (${companyRows(list).length})`],
    ['items', `Позиции (${itemRows(list).length})`]
  ];
  bar.innerHTML = '';
  defs.forEach(([id, label]) => {
    const b = h(`<button class="subtab" role="tab" aria-selected="${id === tab}">${esc(label)}</button>`);
    b.onclick = () => {
      tab = id;
      query = '';
      root.querySelector('#st-search').value = '';
      drawTabs(counted());
      drawTable();
    };
    bar.append(b);
  });
}

const COLUMNS = {
  companies: [
    ['name', 'Компания', (r) => `<span style="font-weight:700">${esc(r.name)}</span>`],
    ['orders', 'Заказов', (r) => int(r.orders)],
    ['revenue', 'Выручка', (r) => money(r.revenue)],
    ['returns', 'Возвратов', (r) => int(r.returns)],
    ['returned', 'Сумма возвратов', (r) => money(r.returned)],
    ['net', 'Чистая', (r) => `<b>${money(r.net)}</b>`],
    ['avg', 'Средний чек', (r) => money(r.avg)],
    ['share', 'Доля', (r) => shareBar(r.share)],
    ['users', 'Заказчиков', (r) => int(r.users)],
    ['last', 'Последний заказ', (r) => fmtDate(r.last)]
  ],
  items: [
    ['name', 'Позиция', (r) => `<span style="font-weight:700">${esc(r.name)}</span>`],
    ['category', 'Категория', (r) => (r.category ? `<span class="pill">${esc(r.category)}</span>` : '<span style="color:var(--ink-3)">—</span>')],
    ['soldQty', 'Заказано, шт', (r) => int(r.soldQty)],
    ['revenue', 'Выручка', (r) => money(r.revenue)],
    ['returnedQty', 'Возвращено, шт', (r) => int(r.returnedQty)],
    ['returned', 'Сумма возвратов', (r) => money(r.returned)],
    ['returnRate', '% возврата', (r) => pct(r.returnRate)],
    ['net', 'Чистая', (r) => `<b>${money(r.net)}</b>`],
    ['orders', 'В заказах', (r) => int(r.orders)],
    ['companies', 'Компаний', (r) => int(r.companies)]
  ]
};

const TEXT_KEYS = new Set(['name', 'category']);

function shareBar(share) {
  return `<div class="share"><div class="share__bar"><span style="width:${Math.min(100, share * 100)}%"></span></div>${pct(share)}</div>`;
}

function drawTable() {
  const wrap = root?.querySelector('#st-wrap');
  if (!wrap) return;

  const list = counted();
  let rows = tab === 'companies' ? companyRows(list) : itemRows(list);

  const q = query.trim().toLowerCase();
  if (q) rows = rows.filter((r) => `${r.name} ${r.category || ''}`.toLowerCase().includes(q));

  if (!rows.length) {
    wrap.innerHTML = `<div class="card__body" style="color:var(--ink-3)">
      ${q ? 'Ничего не найдено.' : 'За выбранный период данных нет.'}</div>`;
    return;
  }

  const { key, dir } = sort[tab];
  rows.sort((a, b) => {
    const x = a[key] ?? '';
    const y = b[key] ?? '';
    const c = TEXT_KEYS.has(key) ? String(x).localeCompare(String(y), 'ru') : (x > y ? 1 : x < y ? -1 : 0);
    return c * dir;
  });

  const cols = COLUMNS[tab];
  wrap.innerHTML = `
    <table class="table">
      <thead><tr>${cols.map(([k, label]) => `
        <th><button class="th-sort" data-sort="${k}"${k === key ? ` aria-sort="${dir > 0 ? 'ascending' : 'descending'}"` : ''}>
          ${label}<span class="th-sort__arrow">${k === key ? (dir > 0 ? '▲' : '▼') : ''}</span></button></th>`).join('')}
      </tr></thead>
      <tbody>${rows.map((r) => `
        <tr>${cols.map(([k, , cell]) => `<td${TEXT_KEYS.has(k) ? '' : ' class="num"'}>${cell(r)}</td>`).join('')}</tr>`).join('')}
      </tbody>
    </table>`;

  wrap.querySelectorAll('[data-sort]').forEach((b) => {
    b.onclick = () => {
      const k = b.dataset.sort;
      const s = sort[tab];
      if (s.key === k) s.dir = -s.dir;
      else { s.key = k; s.dir = TEXT_KEYS.has(k) ? 1 : -1; }
      drawTable();
    };
  });
}
