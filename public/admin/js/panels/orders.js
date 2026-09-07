import { api } from '../api.js';
import { h, esc, toast, confirmDialog, fmtDate } from '../ui.js';
import { paintIcons } from '../icons.js';

let rows = [];
let filter = 'new';       // new | confirmed | rejected | all
let focusId = null;
let root;

const KIND = { order: 'Заказ', return: 'Возврат' };
const STATUS = {
  new: ['Новый', 'pill--warn'],
  confirmed: ['Подтверждён', 'pill--on'],
  rejected: ['Отклонён', 'pill--off']
};

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
    // a deep link should never land on a filter that hides its target
    if (focusId) filter = 'all';

    root.append(h(`
      <div class="card">
        <div class="card__head">
          <div class="subtabs" id="ord-tabs" role="tablist"></div>
        </div>
        <div id="ord-wrap"></div>
      </div>`));

    document.getElementById('ord-refresh')?.addEventListener('click', load);
    await load();
  }
};

async function load() {
  try {
    const qs = filter === 'all' ? '' : `?status=${filter}`;
    rows = await api.get(`/api/admin/orders${qs}`);
    draw();
  } catch (e) {
    toast(e.message, 'err');
  }
}

function draw() {
  drawTabs();
  const wrap = root?.querySelector('#ord-wrap');
  if (!wrap) return;

  if (!rows.length) {
    wrap.innerHTML = `<div class="card__body" style="color:var(--ink-3)">Заказов нет.</div>`;
    return;
  }

  wrap.innerHTML = `
    <table class="table">
      <thead><tr>
        <th style="width:70px">№</th><th style="width:110px">Тип</th>
        <th style="width:180px">Компания</th><th style="width:150px">Заказал</th>
        <th>Позиции</th><th style="width:100px">Итого</th>
        <th style="width:130px">Статус</th><th style="width:150px">Создан</th>
        <th style="width:130px"></th>
      </tr></thead>
      <tbody>${rows.map(rowHTML).join('')}</tbody>
    </table>`;

  wrap.querySelectorAll('[data-decide]').forEach((b) => {
    b.onclick = () => decide(b.dataset.decide, b.dataset.status);
  });

  paintIcons(wrap);
  applyFocus();
}

function drawTabs() {
  const bar = root?.querySelector('#ord-tabs');
  if (!bar) return;
  const defs = [['new', 'Новые'], ['confirmed', 'Подтверждённые'],
                ['rejected', 'Отклонённые'], ['all', 'Все']];
  bar.innerHTML = '';
  defs.forEach(([id, label]) => {
    const b = h(`<button class="subtab" role="tab" aria-selected="${id === filter}">${esc(label)}</button>`);
    b.onclick = () => { filter = id; load(); };
    bar.append(b);
  });
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
          <button class="btn btn--sm" data-decide="${o.id}" data-status="rejected">Отклонить</button>`
        : '<span style="color:var(--ink-3);font-size:12px">—</span>'}
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
