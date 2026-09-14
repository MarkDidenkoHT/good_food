import { api } from '../api.js';
import { h, esc, toast, modal, confirmDialog, onModalCancel } from '../ui.js';
import { paintIcons } from '../icons.js';

/* Three sub-tabs over one nav slot: позиции, категории, сырьё. They share
   a data load because items render category and material names. */

let items = [];
let categories = [];
let materials = [];
let tab = 'items';       // items | categories | materials
let query = '';
let root;
let useCost = true;        // Настройки → Себестоимость сырья: shows material costs

const money = (v) => (v === null || v === undefined ? '—' : `${v} ₽`);

const thumb = (path) => path
  ? `<img class="thumb" src="/api/admin/images/view?path=${encodeURIComponent(path)}" alt="" loading="lazy">`
  : '<span class="thumb thumb--empty"></span>';

export const itemsPanel = {
  id: 'items',
  label: 'Позиции',
  icon: 'items',
  title: 'Позиции',
  subtitle: 'Каталог, категории и сырьё',

  actions: () => [
    h(`<button class="btn btn--ghost btn--icon" id="cat-refresh" title="Обновить"><span data-icon="refresh"></span></button>`),
    h(`<button class="btn btn--primary" id="cat-add"><span data-icon="plus"></span>Добавить</button>`)
  ],

  preload: () => ['/api/admin/items', '/api/admin/categories', '/api/admin/materials'],

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
    document.getElementById('cat-refresh')?.addEventListener('click', () => load(true));

    await load();
  }

};

async function load(fresh = false) {
  try {
    [items, categories, materials] = await Promise.all([
      api.get('/api/admin/items', { fresh }),
      api.get('/api/admin/categories', { fresh }),
      api.get('/api/admin/materials', { fresh })
    ]);
    api.get('/api/admin/settings', { fresh })
      .then((s) => {
        const cost = s.materials?.use_cost !== false;
        if (cost !== useCost) {
          useCost = cost;
          draw();
        }
      })
      .catch(() => {});
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

  // positions are also looked up by their FrontPad article when reconciling
  if (tab === 'items') drawItems(wrap, items.filter((i) => match(i.item_name) || match(i.frontpad_id)));
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
    ['materials', `Сырьё (${materials.length})`]
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
        <th style="width:60px">ID</th><th style="width:56px"></th><th>Название</th><th style="width:170px">Категория</th>
        <th style="width:130px">Заказ</th>
        <th style="width:110px">Цена</th>
        <th style="width:120px">FrontPad</th>
        <th>Сырьё</th><th style="width:110px"></th>
      </tr></thead>
      <tbody>${list.map((i) => `
        <tr${i.available === false ? ' class="row--muted"' : ''}>
          <td class="num">${i.id}</td>
          <td>${thumb(i.image_path)}</td>
          <td style="font-weight:700">${esc(i.item_name || '—')}</td>
          <td>${i.item_category
            ? `<span class="pill">${esc(i.item_category)}</span>`
            : `<span class="pill pill--off">без категории</span>`}</td>
          <td>
            <button class="pill pill--btn ${i.available === false ? 'pill--off' : 'pill--on'}"
                    data-avail="${i.id}"
                    title="${i.available === false ? 'Вернуть в продажу' : 'Снять с продажи'}">
              ${i.available === false ? 'Снята' : 'В продаже'}
            </button>
          </td>
          <td class="num">${money(i.item_cost)}</td>
          <td>${i.frontpad_id
            ? `<span class="pill">${esc(i.frontpad_id)}</span>`
            : `<span class="pill pill--off" title="Позицию нельзя передать в FrontPad">нет артикула</span>`}</td>
          <td>${(Array.isArray(i.materials) ? i.materials : []).length
            ? i.materials.map((m) => `<span class="chip">${esc(m.name)}${chipQty(m)}</span>`).join(' ')
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
        <th style="width:60px">ID</th><th style="width:56px"></th><th>Название</th>
        <th style="width:130px">Позиций</th><th style="width:110px"></th>
      </tr></thead>
      <tbody>${list.map((c) => `
        <tr>
          <td class="num">${c.id}</td>
          <td>${thumb(c.image_path)}</td>
          <td style="font-weight:700">${esc(c.category_name || '—')}</td>
          <td class="num">${items.filter((i) => i.item_category === c.category_name).length}</td>
          ${rowActions(c.id)}
        </tr>`).join('')}
      </tbody>
    </table>`;
}

/* ── material units ─────────────────────────────────────────── */

/* A material is counted in pieces or weighed; an item's qty of it is read in
   that unit, and the material's cost is per piece or per kg. */
const UNITS = { pcs: 'шт', kg: 'кг' };
const unitOf = (m) => (m?.unit === 'kg' ? 'kg' : 'pcs');
const fmtQty = (n) => (Number(n) || 0).toLocaleString('ru-RU', { maximumFractionDigits: 3 });

/* The amount in an item's material chip. A weight is always shown — "Рис"
   alone says nothing about how much — while one piece stays implicit. */
function chipQty(line) {
  const unit = unitOf(materials.find((x) => x.id === line.id));
  if (unit === 'kg') return ` <span class="chip__qty">${fmtQty(line.qty)} кг</span>`;
  return (line.qty || 1) > 1 ? ` <span class="chip__qty">&times;${fmtQty(line.qty)}</span>` : '';
}

/* A quantity box's value in its unit, or null when it is not a usable one. */
function readQty(el) {
  const n = Number(String(el?.value ?? '').replace(',', '.'));
  if (!(n > 0)) return null;
  return el.dataset.unit === 'kg' ? Math.round(n * 1000) / 1000 : Math.max(1, Math.round(n));
}

function drawMaterials(wrap, list) {
  if (!list.length) return empty(wrap);
  wrap.innerHTML = `
    <table class="table">
      <thead><tr>
        <th style="width:60px">ID</th><th>Название</th>
        <th style="width:130px">Учёт</th>
        ${useCost ? '<th style="width:130px">Стоимость</th>' : ''}<th style="width:130px">Используется</th>
        <th style="width:110px"></th>
      </tr></thead>
      <tbody>${list.map((m) => `
        <tr>
          <td class="num">${m.id}</td>
          <td style="font-weight:700">${esc(m.material_name || '—')}</td>
          <td><span class="pill">${unitOf(m) === 'kg' ? 'по весу' : 'в штуках'}</span></td>
          ${useCost ? `<td class="num">${money(m.cost)}${m.cost == null ? '' : ` / ${UNITS[unitOf(m)]}`}</td>` : ''}
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
          ? ' Сырьё будет убрано из всех позиций.'
          : '';
      confirmDialog('Удалить', `Удалить «${nameOf(row)}»?${extra} Действие необратимо.`, async () => {
        await api.del(`/api/admin/${endpoint()}/${row.id}`);
        toast('Удалено');
        await load();
      });
    };
  });

  // One click, no dialog: this is reversible and gets used often.
  wrap.querySelectorAll('[data-avail]').forEach((b) => {
    b.onclick = () => toggleAvailable(items.find((r) => String(r.id) === b.dataset.avail));
  });
}

async function toggleAvailable(item) {
  if (!item) return;
  const next = item.available === false;
  try {
    await api.patch(`/api/admin/items/${item.id}`, { available: next });
    toast(next ? `«${item.item_name}» снова в продаже`
               : `«${item.item_name}» снята с продажи`);
    await load();
  } catch (e) {
    toast(e.message, 'err');
  }
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
      <div class="field">
        <label class="field__label" for="f-cat">Название категории</label>
        <input class="input" id="f-cat" name="category_name" required value="${esc(cat?.category_name || '')}">
        ${isNew ? '' : '<p class="hint">Позиции этой категории будут переназначены на новое название.</p>'}
      </div>
      ${imageFieldHTML(cat?.image_path)}`,
    onSubmit: async (d) => {
      const payload = { category_name: d.category_name, image_path: d.image_path || null };
      if (isNew) await api.post('/api/admin/categories', payload);
      else await api.patch(`/api/admin/categories/${cat.id}`, payload);
      toast(isNew ? 'Категория создана' : 'Сохранено');
      await load();
    }
  });

  imageFolder = 'categories';
  const img = wireImageField(cat?.image_path);
  onModalCancel(img.cleanup);
}

function materialForm(mat) {
  const isNew = !mat;
  const unit = unitOf(mat);
  const costLabel = (u) => `Стоимость за 1 ${UNITS[u]}`;
  const unitHint = (u) => u === 'kg'
    ? 'В позиции указывается вес в кг — например, 0,15 для 150 г.'
    : 'В позиции указывается количество в штуках.';

  modal({
    title: isNew ? 'Новое сырьё' : `Изменить: ${mat.material_name}`,
    submitLabel: isNew ? 'Создать' : 'Сохранить',
    bodyHTML: `
      <div class="field">
        <label class="field__label" for="f-mat">Название сырья</label>
        <input class="input" id="f-mat" name="material_name" required value="${esc(mat?.material_name || '')}">
      </div>
      <div class="field" ${useCost ? '' : 'style="margin-bottom:0"'}>
        <span class="field__label">Учёт</span>
        <div class="seg" id="f-mat-unit">
          <button type="button" data-v="pcs" aria-pressed="${unit === 'pcs'}">В штуках</button>
          <button type="button" data-v="kg"  aria-pressed="${unit === 'kg'}">По весу</button>
        </div>
        <input type="hidden" name="unit" id="f-mat-unit-v" value="${unit}">
        <p class="hint" id="f-mat-unit-hint">${unitHint(unit)}</p>
      </div>
      ${useCost ? `
      <div class="field" style="margin-bottom:0">
        <label class="field__label" for="f-mat-cost" id="f-mat-cost-label">${costLabel(unit)}</label>
        <input class="input" id="f-mat-cost" name="cost" type="number" min="0" step="1"
               value="${mat?.cost ?? ''}" placeholder="0">
        <p class="hint">Целое число. Можно оставить пустым.</p>
      </div>` : ''}`,
    onSubmit: async (d) => {
      const payload = { material_name: d.material_name, unit: d.unit };
      // only sent when the field was on screen, so a hidden field never blanks it
      if (useCost) payload.cost = d.cost;
      if (isNew) await api.post('/api/admin/materials', payload);
      else await api.patch(`/api/admin/materials/${mat.id}`, payload);
      toast(isNew ? 'Сырьё добавлено' : 'Сохранено');
      await load();
    }
  });

  const seg = document.getElementById('f-mat-unit');
  seg?.querySelectorAll('button').forEach((b) => {
    b.onclick = () => {
      const u = b.dataset.v;
      document.getElementById('f-mat-unit-v').value = u;
      const label = document.getElementById('f-mat-cost-label');
      if (label) label.textContent = costLabel(u);
      document.getElementById('f-mat-unit-hint').textContent = unitHint(u);
      seg.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    };
  });
}

function itemForm(item) {
  const isNew = !item;
  const chosen = new Map(
    (Array.isArray(item?.materials) ? item.materials : [])
      .map((m) => [Number(m.id), Number(m.qty) > 0 ? Number(m.qty) : 1])
  );

  modal({
    title: isNew ? 'Новая позиция' : `Изменить: ${item.item_name}`,
    submitLabel: isNew ? 'Создать' : 'Сохранить',
    wide: true,
    // Two columns: what the position *is* on the left, what it is made of on
    // the right. The materials list is the tall part, so standing it beside
    // the short fields is what keeps the dialog on one screen.
    bodyHTML: `
      <div class="form-cols">
        <div>
          <div class="field">
            <label class="field__label" for="f-item">Название позиции</label>
            <input class="input" id="f-item" name="item_name" required value="${esc(item?.item_name || '')}">
          </div>

          <div class="field-row">
            <div class="field">
              <label class="field__label" for="f-item-cat">Категория</label>
              <select class="input" id="f-item-cat" name="item_category">
                <option value="">— без категории —</option>
                ${categories.map((c) => `
                  <option value="${esc(c.category_name)}" ${item?.item_category === c.category_name ? 'selected' : ''}>
                    ${esc(c.category_name)}
                  </option>`).join('')}
              </select>
            </div>
            <div class="field">
              <label class="field__label" for="f-item-cost">Цена</label>
              <input class="input" id="f-item-cost" name="item_cost" type="number" min="0" step="1"
                     value="${item?.item_cost ?? ''}" placeholder="0">
            </div>
          </div>
          <p class="hint" style="margin-top:-10px">Категория необязательна, но для показа
             по категориям в приложении нужна у всех позиций.</p>

          <div class="field">
            <span class="field__label">Доступность</span>
            <div class="seg" id="f-item-avail">
              <button type="button" data-v="on"  aria-pressed="${item?.available !== false}">В продаже</button>
              <button type="button" data-v="off" aria-pressed="${item?.available === false}">Снята</button>
            </div>
            <!-- the segment writes here so the modal's FormData carries it -->
            <input type="hidden" name="available" id="f-item-avail-v"
                   value="${item?.available === false ? 'off' : 'on'}">
            <p class="hint">Снятую позицию нельзя заказать или взять на замену.
               Она остаётся в истории заказов.</p>
          </div>

          <div class="field">
            <label class="field__label" for="f-item-fp">Артикул FrontPad</label>
            <input class="input" id="f-item-fp" name="frontpad_id"
                   value="${esc(item?.frontpad_id || '')}" placeholder="напр. 1024">
            <p class="hint">Код позиции в FrontPad. Без него заказ с этой позицией
               нельзя передать в FrontPad. Один артикул — одна позиция.</p>
          </div>

          ${imageFieldHTML(item?.image_path)}
        </div>

        <div class="field" style="margin-bottom:0">
          <span class="field__label">Сырьё</span>
          ${materials.length
            ? `<div class="picker picker--tall" id="f-mats">${materials.map((m) => {
                const kg = unitOf(m) === 'kg';
                return `
                <div class="picker__row">
                  <input type="checkbox" id="mat-${m.id}" value="${m.id}"
                         data-name="${esc(m.material_name)}" ${chosen.has(m.id) ? 'checked' : ''}>
                  <label for="mat-${m.id}">${esc(m.material_name)}</label>
                  <span class="picker__cost">${useCost ? `${money(m.cost)}${kg && m.cost != null ? ' / кг' : ''}` : ''}</span>
                  <input type="number" class="picker__qty" data-qty-for="${m.id}" data-unit="${unitOf(m)}"
                         min="${kg ? '0.001' : '1'}" step="${kg ? '0.001' : '1'}"
                         value="${chosen.get(m.id) ?? (kg ? '0.1' : 1)}"
                         aria-label="${kg ? 'Вес, кг' : 'Количество'} ${esc(m.material_name)}"
                         ${chosen.has(m.id) ? '' : 'disabled'}>
                  <span class="picker__unit">${UNITS[unitOf(m)]}</span>
                </div>`;
              }).join('')}</div>
               <p class="hint" id="f-mats-sum"></p>`
            : `<p class="hint">Сырья пока нет — добавьте его на вкладке «Сырьё».</p>`}
        </div>
      </div>`,
    onSubmit: async (d) => {
      const picked = [...document.querySelectorAll('#f-mats input[type=checkbox]:checked')]
        .map((c) => ({
          id: Number(c.value),
          name: c.dataset.name,
          qty: readQty(document.querySelector(`#f-mats [data-qty-for="${c.value}"]`))
        }));
      const bad = picked.find((m) => m.qty === null);
      if (bad) {
        toast(`Укажите количество для «${bad.name}»`, 'err');
        return false;
      }
      const payload = {
        item_name: d.item_name,
        item_category: d.item_category || null,
        item_cost: d.item_cost,
        image_path: d.image_path || null,
        available: d.available !== 'off',
        frontpad_id: d.frontpad_id || null,
        materials: picked
      };
      if (isNew) await api.post('/api/admin/items', payload);
      else await api.patch(`/api/admin/items/${item.id}`, payload);
      toast(isNew ? 'Позиция создана' : 'Сохранено');
      await load();
    }
  });

  imageFolder = 'items';
  const img = wireImageField(item?.image_path);
  onModalCancel(img.cleanup);

  const availSeg = document.getElementById('f-item-avail');
  const availVal = document.getElementById('f-item-avail-v');
  availSeg?.querySelectorAll('button').forEach((b) => {
    b.onclick = () => {
      availVal.value = b.dataset.v;
      availSeg.querySelectorAll('button').forEach((x) => {
        x.setAttribute('aria-pressed', String(x === b));
      });
    };
  });

  // running total of the picked materials — a sanity check against the price
  const box = document.getElementById('f-mats');
  const sum = document.getElementById('f-mats-sum');
  if (box && sum) {
    const recalc = () => {
      const rows = [...box.querySelectorAll('input[type=checkbox]')].map((c) => {
        const qtyEl = box.querySelector(`[data-qty-for="${c.value}"]`);
        // a quantity box is only meaningful while its material is ticked
        if (qtyEl) qtyEl.disabled = !c.checked;
        return { id: Number(c.value), on: c.checked, unit: qtyEl?.dataset.unit, qty: readQty(qtyEl) || 0 };
      }).filter((r) => r.on);

      const pcs = rows.filter((r) => r.unit !== 'kg').reduce((acc, r) => acc + r.qty, 0);
      const kg = rows.filter((r) => r.unit === 'kg').reduce((acc, r) => acc + r.qty, 0);
      const total = Math.round(rows.reduce((acc, r) => {
        const m = materials.find((x) => x.id === r.id);
        return acc + (m?.cost || 0) * r.qty;
      }, 0));

      const amounts = [pcs && `${fmtQty(pcs)} шт.`, kg && `${fmtQty(kg)} кг`].filter(Boolean);
      sum.textContent = rows.length
        ? `Выбрано: ${rows.length} назв. · ${amounts.join(' · ')}${useCost ? ` · себестоимость ${total} ₽` : ''}`
        : 'Ничего не выбрано.';
    };
    box.addEventListener('change', recalc);
    box.addEventListener('input', recalc);
    recalc();
  }
}

/* ── image picker ───────────────────────────────────────────── */

/* The bucket is private, so the preview goes through the panel's own signed
   redirect rather than a public URL. `pending` is the path chosen in this
   dialog but not yet saved — discarded if the dialog is cancelled. */
const imageSrc = (path) => `/api/admin/images/view?path=${encodeURIComponent(path)}`;

function imageFieldHTML(path) {
  return `
    <div class="field" style="margin-bottom:0">
      <span class="field__label">Изображение</span>
      <div class="imgpick imgpick--lg" id="imgpick">
        <div class="imgpick__preview" id="img-preview">
          ${path ? `<img src="${imageSrc(path)}" alt="">` : '<span>нет</span>'}
        </div>
        <div class="imgpick__actions">
          <input type="file" id="img-file" accept="image/jpeg,image/png,image/webp,image/gif" hidden>
          <input type="hidden" name="image_path" id="img-path" value="${esc(path || '')}">
          <button type="button" class="btn btn--sm" id="img-choose">Загрузить</button>
          <button type="button" class="btn btn--sm" id="img-clear" ${path ? '' : 'disabled'}>Убрать</button>
          <p class="hint" id="img-hint">JPEG, PNG, WebP или GIF, до 5 МБ.</p>
        </div>
      </div>
    </div>`;
}

/* Returns a cleanup() the caller runs on cancel, so an upload that was never
   saved does not leave an orphan in the bucket. */
function wireImageField(originalPath) {
  const file = document.getElementById('img-file');
  const hidden = document.getElementById('img-path');
  const preview = document.getElementById('img-preview');
  const hint = document.getElementById('img-hint');
  const clear = document.getElementById('img-clear');
  const uploaded = [];

  const show = (path) => {
    hidden.value = path || '';
    clear.disabled = !path;
    preview.innerHTML = path ? `<img src="${imageSrc(path)}" alt="">` : '<span>нет</span>';
  };

  document.getElementById('img-choose').onclick = () => file.click();

  file.onchange = async () => {
    const f = file.files?.[0];
    if (!f) return;
    if (f.size > 5 * 1024 * 1024) { hint.textContent = 'Файл больше 5 МБ'; return; }

    hint.textContent = 'Загрузка…';
    try {
      // raw body, not multipart: one file and no form fields to encode
      const res = await fetch(`/api/admin/images?folder=${imageFolder}`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': f.type },
        body: f
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Не удалось загрузить');

      uploaded.push(data.path);
      show(data.path);
      hint.textContent = 'Загружено.';
    } catch (e) {
      hint.textContent = e.message;
    } finally {
      file.value = '';
    }
  };

  clear.onclick = () => { show(''); hint.textContent = 'Будет удалено при сохранении.'; };

  return {
    // everything uploaded in this dialog except what is actually being saved
    cleanup() {
      uploaded
        .filter((path) => path !== hidden.value)
        .forEach((path) => api.del(`/api/admin/images?path=${encodeURIComponent(path)}`).catch(() => {}));
    }
  };
}

let imageFolder = 'items';
