import { api } from '../api.js';
import { h, esc, toast, modal, confirmDialog } from '../ui.js';
import { paintIcons } from '../icons.js';

/* Three sub-tabs over one nav slot: позиции, категории, материалы. They share
   a data load because items render category and material names. */

let items = [];
let categories = [];
let materials = [];
let tab = 'items';       // items | categories | materials
let query = '';
let root;

const money = (v) => (v === null || v === undefined ? '—' : `${v} ₽`);

export const itemsPanel = {
  id: 'items',
  label: 'Позиции',
  icon: 'items',
  title: 'Позиции',
  subtitle: 'Каталог, категории и материалы',

  actions: () => [
    h(`<button class="btn btn--ghost btn--icon" id="cat-refresh" title="Обновить"><span data-icon="refresh"></span></button>`),
    h(`<button class="btn btn--primary" id="cat-add"><span data-icon="plus" style="width:16px;height:16px;display:grid"></span>Добавить</button>`)
  ],

  async render(container) {
    root = container;
    root.append(h(`
      <div class="card">
        <div class="card__head">
          <div class="subtabs" id="subtabs" role="tablist"></div>
          <div style="flex:1 1 auto"></div>
          <div style="position:relative;width:260px">
            <input class="input" id="cat-search" placeholder="Поиск по названию" style="padding-left:34px">
            <span data-icon="search" style="position:absolute;left:10px;top:9px;width:18px;height:18px;color:var(--ink-3)"></span>
          </div>
        </div>
        <div id="cat-table-wrap"></div>
      </div>`));

    const search = root.querySelector('#cat-search');
    search.value = query;
    search.addEventListener('input', () => { query = search.value; draw(); });

    document.getElementById('cat-add')?.addEventListener('click', openForm);
    document.getElementById('cat-refresh')?.addEventListener('click', load);

    await load();
  },

  asideTabs: [{
    id: 'items-summary',
    label: 'Сводка',
    render() {
      const noCat = items.filter((i) => !i.item_category).length;
      return h(`
        <div>
          <div class="field">
            <span class="field__label">Каталог</span>
            <div class="pill">Позиций: ${items.length}</div>
            <div class="pill" style="margin-top:6px">Категорий: ${categories.length}</div>
            <div class="pill" style="margin-top:6px">Материалов: ${materials.length}</div>
          </div>
          <div class="field" style="margin-bottom:0">
            <span class="field__label">Без категории</span>
            <div class="pill ${noCat ? 'pill--off' : 'pill--on'}">${noCat}</div>
            <p class="hint">Показ по категориям в приложении можно включить, только когда у всех позиций есть категория.</p>
          </div>
        </div>`);
    }
  }]
};

async function load() {
  try {
    [items, categories, materials] = await Promise.all([
      api.get('/api/admin/items'),
      api.get('/api/admin/categories'),
      api.get('/api/admin/materials')
    ]);
    draw();
  } catch (e) {
    toast(e.message, 'err');
  }
}

function draw() {
  drawTabs();
  const wrap = root?.querySelector('#cat-table-wrap');
  if (!wrap) return;

  const q = query.trim().toLowerCase();
  const match = (name) => !q || String(name || '').toLowerCase().includes(q);

  if (tab === 'items') drawItems(wrap, items.filter((i) => match(i.item_name)));
  if (tab === 'categories') drawCategories(wrap, categories.filter((c) => match(c.category_name)));
  if (tab === 'materials') drawMaterials(wrap, materials.filter((m) => match(m.material_name)));

  wireRowActions(wrap);
  paintIcons(wrap);
}

function drawTabs() {
  const bar = root?.querySelector('#subtabs');
  if (!bar) return;
  const defs = [
    ['items', `Позиции (${items.length})`],
    ['categories', `Категории (${categories.length})`],
    ['materials', `Материалы (${materials.length})`]
  ];
  bar.innerHTML = '';
  defs.forEach(([id, label]) => {
    const b = h(`<button class="subtab" role="tab" aria-selected="${id === tab}">${esc(label)}</button>`);
    b.onclick = () => { tab = id; query = ''; root.querySelector('#cat-search').value = ''; draw(); };
    bar.append(b);
  });
}

function empty(wrap) {
  wrap.innerHTML = `<div class="card__body" style="color:var(--ink-3)">Ничего не найдено.</div>`;
}

function drawItems(wrap, list) {
  if (!list.length) return empty(wrap);
  wrap.innerHTML = `
    <table class="table">
      <thead><tr>
        <th style="width:60px">ID</th><th>Название</th><th style="width:170px">Категория</th>
        <th style="width:110px">Цена</th><th>Материалы</th><th style="width:110px"></th>
      </tr></thead>
      <tbody>${list.map((i) => `
        <tr>
          <td class="num">${i.id}</td>
          <td style="font-weight:700">${esc(i.item_name || '—')}</td>
          <td>${i.item_category
            ? `<span class="pill">${esc(i.item_category)}</span>`
            : `<span class="pill pill--off">без категории</span>`}</td>
          <td class="num">${money(i.item_cost)}</td>
          <td>${(Array.isArray(i.materials) ? i.materials : []).length
            ? i.materials.map((m) => `<span class="chip">${esc(m.name)}</span>`).join(' ')
            : '<span style="color:var(--ink-3)">—</span>'}</td>
          ${rowActions(i.id)}
        </tr>`).join('')}
      </tbody>
    </table>`;
}

function drawCategories(wrap, list) {
  if (!list.length) return empty(wrap);
  wrap.innerHTML = `
    <table class="table">
      <thead><tr>
        <th style="width:60px">ID</th><th>Название</th>
        <th style="width:130px">Позиций</th><th style="width:110px"></th>
      </tr></thead>
      <tbody>${list.map((c) => `
        <tr>
          <td class="num">${c.id}</td>
          <td style="font-weight:700">${esc(c.category_name || '—')}</td>
          <td class="num">${items.filter((i) => i.item_category === c.category_name).length}</td>
          ${rowActions(c.id)}
        </tr>`).join('')}
      </tbody>
    </table>`;
}

function drawMaterials(wrap, list) {
  if (!list.length) return empty(wrap);
  wrap.innerHTML = `
    <table class="table">
      <thead><tr>
        <th style="width:60px">ID</th><th>Название</th>
        <th style="width:130px">Стоимость</th><th style="width:130px">Используется</th>
        <th style="width:110px"></th>
      </tr></thead>
      <tbody>${list.map((m) => `
        <tr>
          <td class="num">${m.id}</td>
          <td style="font-weight:700">${esc(m.material_name || '—')}</td>
          <td class="num">${money(m.cost)}</td>
          <td class="num">${items.filter((i) =>
            (Array.isArray(i.materials) ? i.materials : []).some((x) => x.id === m.id)).length}</td>
          ${rowActions(m.id)}
        </tr>`).join('')}
      </tbody>
    </table>`;
}

const rowActions = (id) => `
  <td><div class="row-actions">
    <button class="btn btn--ghost btn--icon btn--sm" data-edit="${id}" title="Изменить"><span data-icon="edit"></span></button>
    <button class="btn btn--ghost btn--icon btn--sm" data-del="${id}" title="Удалить"><span data-icon="trash"></span></button>
  </div></td>`;

function currentList() {
  return tab === 'items' ? items : tab === 'categories' ? categories : materials;
}

function nameOf(row) {
  return row.item_name || row.category_name || row.material_name || '';
}

function endpoint() {
  return tab === 'items' ? 'items' : tab === 'categories' ? 'categories' : 'materials';
}

function wireRowActions(wrap) {
  wrap.querySelectorAll('[data-edit]').forEach((b) => {
    b.onclick = () => openForm(currentList().find((r) => String(r.id) === b.dataset.edit));
  });
  wrap.querySelectorAll('[data-del]').forEach((b) => {
    b.onclick = () => {
      const row = currentList().find((r) => String(r.id) === b.dataset.del);
      const extra = tab === 'categories'
        ? ' Позиции этой категории останутся, но потеряют категорию.'
        : tab === 'materials'
          ? ' Материал будет убран из всех позиций.'
          : '';
      confirmDialog('Удалить', `Удалить «${nameOf(row)}»?${extra} Действие необратимо.`, async () => {
        await api.del(`/api/admin/${endpoint()}/${row.id}`);
        toast('Удалено');
        await load();
      });
    };
  });
}

/* ── forms ──────────────────────────────────────────────────── */

function openForm(row) {
  const isNew = !row || !row.id;
  if (tab === 'categories') return categoryForm(isNew ? null : row);
  if (tab === 'materials') return materialForm(isNew ? null : row);
  return itemForm(isNew ? null : row);
}

function categoryForm(cat) {
  const isNew = !cat;
  modal({
    title: isNew ? 'Новая категория' : `Изменить: ${cat.category_name}`,
    submitLabel: isNew ? 'Создать' : 'Сохранить',
    bodyHTML: `
      <div class="field" style="margin-bottom:0">
        <label class="field__label" for="f-cat">Название категории</label>
        <input class="input" id="f-cat" name="category_name" required value="${esc(cat?.category_name || '')}">
        ${isNew ? '' : '<p class="hint">Позиции этой категории будут переназначены на новое название.</p>'}
      </div>`,
    onSubmit: async (d) => {
      const payload = { category_name: d.category_name };
      if (isNew) await api.post('/api/admin/categories', payload);
      else await api.patch(`/api/admin/categories/${cat.id}`, payload);
      toast(isNew ? 'Категория создана' : 'Сохранено');
      await load();
    }
  });
}

function materialForm(mat) {
  const isNew = !mat;
  modal({
    title: isNew ? 'Новый материал' : `Изменить: ${mat.material_name}`,
    submitLabel: isNew ? 'Создать' : 'Сохранить',
    bodyHTML: `
      <div class="field">
        <label class="field__label" for="f-mat">Название материала</label>
        <input class="input" id="f-mat" name="material_name" required value="${esc(mat?.material_name || '')}">
      </div>
      <div class="field" style="margin-bottom:0">
        <label class="field__label" for="f-mat-cost">Стоимость</label>
        <input class="input" id="f-mat-cost" name="cost" type="number" min="0" step="1"
               value="${mat?.cost ?? ''}" placeholder="0">
        <p class="hint">Целое число. Можно оставить пустым.</p>
      </div>`,
    onSubmit: async (d) => {
      const payload = { material_name: d.material_name, cost: d.cost };
      if (isNew) await api.post('/api/admin/materials', payload);
      else await api.patch(`/api/admin/materials/${mat.id}`, payload);
      toast(isNew ? 'Материал создан' : 'Сохранено');
      await load();
    }
  });
}

function itemForm(item) {
  const isNew = !item;
  const chosen = new Map(
    (Array.isArray(item?.materials) ? item.materials : []).map((m) => [Number(m.id), m.name])
  );

  modal({
    title: isNew ? 'Новая позиция' : `Изменить: ${item.item_name}`,
    submitLabel: isNew ? 'Создать' : 'Сохранить',
    bodyHTML: `
      <div class="field">
        <label class="field__label" for="f-item">Название позиции</label>
        <input class="input" id="f-item" name="item_name" required value="${esc(item?.item_name || '')}">
      </div>
      <div class="field">
        <label class="field__label" for="f-item-cat">Категория</label>
        <select class="input" id="f-item-cat" name="item_category">
          <option value="">— без категории —</option>
          ${categories.map((c) => `
            <option value="${esc(c.category_name)}" ${item?.item_category === c.category_name ? 'selected' : ''}>
              ${esc(c.category_name)}
            </option>`).join('')}
        </select>
        <p class="hint">Необязательно. Но для показа по категориям в приложении нужна у всех позиций.</p>
      </div>
      <div class="field">
        <label class="field__label" for="f-item-cost">Цена</label>
        <input class="input" id="f-item-cost" name="item_cost" type="number" min="0" step="1"
               value="${item?.item_cost ?? ''}" placeholder="0">
      </div>
      <div class="field" style="margin-bottom:0">
        <span class="field__label">Материалы</span>
        ${materials.length
          ? `<div class="picker" id="f-mats">${materials.map((m) => `
              <label class="picker__row">
                <input type="checkbox" value="${m.id}" data-name="${esc(m.material_name)}"
                       ${chosen.has(m.id) ? 'checked' : ''}>
                <span>${esc(m.material_name)}</span>
                <span class="picker__cost">${money(m.cost)}</span>
              </label>`).join('')}</div>
             <p class="hint" id="f-mats-sum"></p>`
          : `<p class="hint">Материалов пока нет — добавьте их на вкладке «Материалы».</p>`}
      </div>`,
    onSubmit: async (d) => {
      const picked = [...document.querySelectorAll('#f-mats input:checked')]
        .map((c) => ({ id: Number(c.value), name: c.dataset.name }));
      const payload = {
        item_name: d.item_name,
        item_category: d.item_category || null,
        item_cost: d.item_cost,
        materials: picked
      };
      if (isNew) await api.post('/api/admin/items', payload);
      else await api.patch(`/api/admin/items/${item.id}`, payload);
      toast(isNew ? 'Позиция создана' : 'Сохранено');
      await load();
    }
  });

  // running total of the picked materials — a sanity check against the price
  const box = document.getElementById('f-mats');
  const sum = document.getElementById('f-mats-sum');
  if (box && sum) {
    const recalc = () => {
      const picked = [...box.querySelectorAll('input:checked')].map((c) => Number(c.value));
      const total = materials
        .filter((m) => picked.includes(m.id))
        .reduce((acc, m) => acc + (m.cost || 0), 0);
      sum.textContent = picked.length
        ? `Выбрано: ${picked.length} · себестоимость ${total} ₽`
        : 'Ничего не выбрано.';
    };
    box.addEventListener('change', recalc);
    recalc();
  }
}
