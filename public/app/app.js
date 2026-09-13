/* Good Food mini-app. Two modes over one catalog: an order and a return
   differ only by the `kind` sent with the basket. Materials and their costs
   are never fetched here — customers see items and prices only. */

import { hideSplash, showLoader, loaderHTML } from '/loader.js';

const tg = window.Telegram?.WebApp;
tg?.ready();
tg?.expand();
/* On iOS, dragging down while scrolling the catalog would minimise the app. */
if (tg?.isVersionAtLeast?.('7.7')) tg.disableVerticalSwipes();

/* Follow the theme of the Telegram client the app is embedded in. */
function syncTheme() {
  const dark = tg ? tg.colorScheme === 'dark'
                  : matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}
syncTheme();
tg?.onEvent?.('themeChanged', syncTheme);

const view = document.getElementById('view');

let me = null;
let catalog = {
  items: [], categories: [], group_by_category: false, show_images: false,
  image_size: 'md',
  orders: {
    cutoff_enabled: false, allow_delete_new: false,
    allow_edit_confirmed: false, ordering_blocked: false
  }
};
let kind = 'order';                 // order | return
let screen = 'catalog';             // catalog | history
/* Set while an already-sent order is being changed: the basket of that kind
   then stands for that order rather than for a new one. */
let editing = null;                 // { id, kind } | null
/* An order and a return are separate documents, so they get separate
   baskets: adding to one never touches the other. */
const carts = { order: new Map(), return: new Map() };
const cart = () => carts[kind];

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const post = (url, body) => send('POST', url, body);

async function send(method, url, body) {
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {})
  });
  const data = await res.json().catch(() => ({}));
  /* The company code was reissued while this app was open. Whatever the user
     was in the middle of is over: the screen goes back to the door. */
  if (res.status === 409 && data?.error === 'code_rotated') renderRotated();
  return { ok: res.ok, status: res.status, data };
}

async function get(url) {
  const res = await fetch(url, { credentials: 'same-origin' });
  if (res.status === 409) {
    const data = await res.json().catch(() => ({}));
    if (data.error === 'code_rotated') { renderRotated(); throw new Error('code_rotated'); }
  }
  if (!res.ok) throw new Error('load failed');
  return res.json();
}

function toast(text, kindName = 'ok') {
  const el = document.createElement('div');
  el.className = `toast ${kindName === 'err' ? 'toast--err' : ''}`;
  el.textContent = text;
  document.body.append(el);
  setTimeout(() => el.remove(), 2800);
}

/* ── boot ───────────────────────────────────────────────────── */

/* The signed initData Telegram supplies on launch is the only thing that
   identifies anybody here. Outside Telegram there is no signature to check
   and nothing that could stand in for one — a chat id is public, so typing
   one proves nothing — which is why there is no browser login any more. */

async function start() {
  const initData = tg?.initData || '';

  // An existing session outruns both paths.
  const session = await fetch('/api/auth/user/me', { credentials: 'same-origin' });
  if (session.ok) { me = await session.json(); return openApp(); }

  if (!initData) return renderOutsideTelegram();

  const { ok, status, data } = await post('/api/auth/user/telegram', { initData });
  if (ok) { me = data; return openApp(); }

  if (status === 404) return centered('Вы ещё не зарегистрированы',
    'Откройте бота и нажмите /start, затем вернитесь сюда.');
  if (data.error === 'company_blocked') return centered('Доступ компании закрыт',
    'Свяжитесь с менеджером.');
  if (data.error === 'code_rotated') return renderRotated();
  if (data.error === 'no_company') return renderJoin();
  if (status === 403) return renderPending();
  return renderOutsideTelegram();
}

/* Opened anywhere but inside Telegram — or with a launch payload the server
   would not verify. There is no form to offer: without the signature the app
   cannot establish who this is, and no amount of typing would change that. */
const renderOutsideTelegram = () => centered('Откройте через Telegram',
  'Приложение работает внутри Telegram. Откройте бота и запустите его оттуда.');

function centered(title, text, extraHTML = '') {
  view.innerHTML = `
    <div class="center"><div class="center__box">
      <div class="mark">GF</div>
      <h1>${esc(title)}</h1>
      <p>${esc(text)}</p>
      ${extraHTML}
    </div></div>`;
}

/* The code gate. It is the last step of registering for somebody new, and
   the way back in for somebody whose company reissued its code — the same
   form either way, only the words above it change. */
function renderJoin(
  title = 'Код компании',
  text = 'Введите код компании, чтобы завершить регистрацию.'
) {
  centered(title, text, `
    <form id="join">
      <input class="code-input" id="code" maxlength="32" autocomplete="one-time-code"
             autocapitalize="off" spellcheck="false" placeholder="Код компании" required>
      <button class="btn" type="submit" style="margin-top:12px">Продолжить</button>
      <div class="err" id="err"></div>
    </form>`);

  document.getElementById('join').onsubmit = (e) => {
    e.preventDefault();
    submitJoin(document.getElementById('code').value.trim());
  };
}

const renderRotated = () => renderJoin('Код компании изменён',
  'Запросите новый код у руководителя и введите его здесь.');

const renderPending = () => centered('Заявка на рассмотрении',
  'Менеджер откроет доступ — вы получите сообщение в Telegram.');

async function submitJoin(code) {
  const err = document.getElementById('err');
  if (err) err.textContent = '';

  const { ok, status, data } = await post('/api/auth/user/join',
    { code, initData: tg?.initData || '' });
  if (ok) { me = data; return openApp(); }

  /* The code was right — they are now attached to the company and the
     operators have been told. Nothing more for them to type. */
  if (data.error === 'pending') return renderPending();

  /* The launch payload went stale while the form was open — it carries a
     timestamp the server will not accept for ever. Relaunching is the only
     way to get a fresh one, so say that instead of blaming the code. */
  if (data.error === 'need_telegram') return renderOutsideTelegram();

  const message =
    status === 404 ? 'Сначала нажмите /start в боте'
    : data.error === 'company_blocked' ? 'Доступ компании закрыт'
    : data.error || 'Неверный код';

  if (err) err.textContent = message;
  else toast(message, 'err');
}

/* Re-read the catalog after the server refused something. Both the rules and
   the item list may have moved on since the app was opened, and the screen
   has to stop offering whatever would just be refused again. */
async function refreshRules() {
  try {
    catalog = await get('/api/app/catalog');
    pruneOrderCart();
  } catch { /* leave the last known catalog in place */ }
}

/* An item withdrawn while the basket was open leaves the order basket. The
   return basket keeps it — sending one back is still allowed. */
function pruneOrderCart() {
  for (const id of [...carts.order.keys()]) {
    const it = catalog.items.find((x) => x.id === id);
    if (!it || orderable(it)) continue;
    carts.order.delete(id);
  }
}

async function openApp() {
  try {
    catalog = await get('/api/app/catalog');
  } catch {
    return centered('Не удалось загрузить каталог', 'Попробуйте позже.');
  }
  render();
}

/* ── render ─────────────────────────────────────────────────── */

function render() {
  view.innerHTML = `
    <div class="head">
      <div class="wrap">
        <div class="head__row">
          <div class="head__name">${esc(me.company_name || 'Компания')}</div>
          <div class="head__who">${esc(me.user_name || '')}</div>
          ${catalog.can_reset_code ? `
          <button class="head__key" id="rotate-code" type="button"
                  title="Перевыпустить код компании" aria-label="Перевыпустить код компании">🔑</button>` : ''}
        </div>
        <div class="tabs">
          <button class="tab" data-screen="catalog" data-kind="order"
                  aria-selected="${screen === 'catalog' && kind === 'order'}"
                  ${editing && editing.kind !== 'order' ? 'disabled' : ''}>
            Заказ<span class="tab__count" data-count="order"></span>
          </button>
          ${returnsFromHistory() ? '' : `
          <button class="tab" data-screen="catalog" data-kind="return"
                  aria-selected="${screen === 'catalog' && kind === 'return'}"
                  ${editing && editing.kind !== 'return' ? 'disabled' : ''}>
            Возврат<span class="tab__count" data-count="return"></span>
          </button>`}
          <button class="tab" data-screen="history"
                  aria-selected="${screen === 'history'}">История</button>
        </div>
      </div>
    </div>
    <div class="wrap" id="body"></div>`;

  const rotate = view.querySelector('#rotate-code');
  if (rotate) rotate.onclick = rotateCode;

  view.querySelectorAll('.tab').forEach((b) => {
    b.onclick = () => {
      if (b.dataset.kind) kind = b.dataset.kind;
      screen = b.dataset.screen;
      render();
    };
  });

  paintTabCounts();

  if (screen === 'return') return renderReturn();
  if (screen === 'history') return renderHistory();
  renderCatalog();
}

/* The owner's kill switch, shown only where an operator has allowed it.

   One press stops every one of their employees where they stand — and the
   new code comes back to the owner alone, because handing access back is
   meant to be deliberate and one person at a time. The wording says exactly
   that before anything happens; there is no undoing it afterwards. */
async function rotateCode() {
  const warned = await ask(
    'Перевыпустить код компании?\n\n' +
    'Все сотрудники сразу потеряют доступ к приложению. ' +
    'Вернутся только те, кому вы передадите новый код.');
  if (!warned) return;

  const { ok, data } = await post('/api/app/company/rotate-code', {});
  if (!ok) return toast(data.error || 'Не удалось перевыпустить код', 'err');

  say(`Новый код компании: ${data.company_code}\n\n` +
      'Он также отправлен вам в Telegram. Передайте его тем, ' +
      'кто должен сохранить доступ.');
}

/* Telegram's own dialogs inside the client, the browser's outside it. */
const ask = (text) => new Promise((resolve) => {
  if (tg?.showConfirm) tg.showConfirm(text, (yes) => resolve(Boolean(yes)));
  else resolve(window.confirm(text));
});

const say = (text) => (tg?.showAlert ? tg.showAlert(text) : window.alert(text));

/* Each tab shows how much is waiting in its own basket — the clearest way to
   say the two are not one list. */
function paintTabCounts() {
  document.querySelectorAll('.tab__count').forEach((el) => {
    const units = [...carts[el.dataset.count].values()].reduce((a, n) => a + n, 0);
    el.textContent = units || '';
    el.hidden = !units;
  });
}

/* With this on, a return is not composed from the catalogue: there is no
   Возврат tab, and the customer starts one from a past order in История. */
const returnsFromHistory = () => Boolean(catalog.orders?.returns_from_history);

/* A withdrawn item can still be sent back, so it stays in the return list and
   leaves the order one. */
const orderable = (it) => it.available !== false;
const forKind = () => (kind === 'return' ? catalog.items : catalog.items.filter(orderable));

function renderCatalog() {
  const body = document.getElementById('body');
  const items = forKind();

  if (!items.length) {
    body.innerHTML = `${blockedBanner()}${editingBanner()}<div class="empty">${
      catalog.items.length ? 'Сейчас нечего заказать.' : 'Каталог пуст.'
    }</div>`;
    body.querySelector('#edit-cancel')?.addEventListener('click', cancelEdit);
    return renderCart();
  }

  let html = '';
  if (catalog.group_by_category) {
    // the admin panel refuses to enable grouping while an item lacks a
    // category, so an "Без категории" bucket should never appear — it is here
    // only so nothing silently vanishes if the data changes underneath
    const groups = new Map();
    for (const it of items) {
      const key = it.item_category || 'Без категории';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(it);
    }
    for (const [name, list] of [...groups].sort((a, b) => a[0].localeCompare(b[0], 'ru'))) {
      const cat = catalog.categories.find((c) => c.name === name);
      html += `<div class="group__title">
        ${catalog.show_images && cat?.image
          ? `<img class="group__img" src="${cat.image}" alt="" loading="lazy">` : ''}
        <span>${esc(name)}</span>
      </div>`;
      html += `<div class="list">${list.map(itemHTML).join('')}</div>`;
    }
  } else {
    html = `<div class="list">${items.map(itemHTML).join('')}</div>`;
  }

  applyImageSize();
  body.innerHTML = blockedBanner() + editingBanner() + html;
  body.querySelector('#edit-cancel')?.addEventListener('click', cancelEdit);
  body.querySelectorAll('[data-plus]').forEach((b) => {
    b.onclick = () => bump(Number(b.dataset.plus), +1);
  });
  body.querySelectorAll('[data-minus]').forEach((b) => {
    b.onclick = () => bump(Number(b.dataset.minus), -1);
  });
  renderCart();
}

/* The admin picks one of three sizes; the sizes themselves live in the CSS,
   so this only has to say which one is on. */
function applyImageSize() {
  const size = ['sm', 'md', 'lg'].includes(catalog.image_size) ? catalog.image_size : 'md';
  document.documentElement.dataset.imgsize = size;
}

function itemHTML(it) {
  const qty = cart().get(it.id) || 0;
  return `
    <div class="item ${qty ? 'item--picked' : ''}">
      ${catalog.show_images
        ? (it.image
            ? `<img class="item__img" src="${it.image}" alt="" loading="lazy">`
            : '<span class="item__img item__img--none"></span>')
        : ''}
      <div class="item__body">
        <div class="item__name">${esc(it.item_name)}</div>
        <div class="item__cost">${it.item_cost ?? 0} ₽</div>
      </div>
      <div class="stepper ${qty ? '' : 'stepper--empty'}">
        <button class="stepper__minus" data-minus="${it.id}" aria-label="Убрать">−</button>
        <span class="stepper__qty">${qty}</span>
        <button class="stepper__plus" data-plus="${it.id}" aria-label="Добавить">+</button>
      </div>
    </div>`;
}

function bump(id, delta) {
  const basket = cart();
  const next = (basket.get(id) || 0) + delta;
  if (next <= 0) basket.delete(id);
  else basket.set(id, Math.min(999, next));
  renderCatalog();
  paintTabCounts();
}

/* ── editing a sent order ───────────────────────────────────── */

/* The catalog looks the same whether a basket is new or is standing in for a
   sent order, so say plainly which one is being changed — and give the way
   back out. */
/* Ordering is shut between the cutoff and the next morning when the setting
   says so; saying when it opens again is more use than a dead button. */
function blockedBanner() {
  const o = catalog.orders || {};
  if (!o.ordering_blocked) return '';
  const when = o.resumes_at
    ? new Date(o.resumes_at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
    : '';
  return `<div class="notice">Приём заказов закрыт${when ? ` до ${when}` : ''}.
    Изменить уже отправленные заказы тоже нельзя.</div>`;
}

function editingBanner() {
  if (!editing) return '';
  return `
    <div class="editbar">
      <span>Изменение ${editing.kind === 'return' ? 'возврата' : 'заказа'} #${editing.id}</span>
      <button class="editbar__cancel" id="edit-cancel" type="button">Отмена</button>
    </div>`;
}

function startEdit(order) {
  editing = { id: order.id, kind: order.kind };
  kind = order.kind;
  // the sent lines become the basket; the catalog is then edited as usual
  carts[kind] = new Map(
    (Array.isArray(order.items) ? order.items : [])
      .map((l) => [Number(l.id), Math.max(1, Number(l.qty) || 1)])
  );
  screen = 'catalog';
  render();
}

function cancelEdit() {
  if (!editing) return;
  carts[editing.kind].clear();
  editing = null;
  screen = 'history';
  render();
}

/* Repeat: the old lines go into the basket for the customer to look over and
   send as a new order — a re-order is a new document, not a copy of a closed
   one. Quantities add up, so repeating twice orders twice as much. */
function repeatOrder(order) {
  if (editing) return toast('Сначала завершите изменение заказа', 'err');

  const basket = carts[order.kind];
  const wantsOrder = order.kind !== 'return';
  let missing = 0;
  for (const line of Array.isArray(order.items) ? order.items : []) {
    const id = Number(line.id);
    const it = catalog.items.find((i) => i.id === id);
    // the catalog may have moved on since: a line that is gone cannot be
    // repriced, and one that is withdrawn cannot be ordered again — though it
    // can still be returned
    if (!it || (wantsOrder && !orderable(it))) { missing++; continue; }
    basket.set(id, Math.min(999, (basket.get(id) || 0) + (Number(line.qty) || 1)));
  }

  if (!basket.size) {
    return toast(wantsOrder ? 'Эти позиции больше не заказать' : 'Этих позиций больше нет в каталоге', 'err');
  }
  if (missing) toast(`${missing} поз. больше недоступно`, 'err');

  kind = order.kind;
  screen = 'catalog';
  render();
}

async function deleteOrder(order) {
  if (!await ask(`Отменить ${order.kind === 'return' ? 'возврат' : 'заказ'} #${order.id}?`)) return;
  const { ok, data } = await send('DELETE', `/api/app/orders/${order.id}`);
  if (!ok) return toast(data.error || 'Не удалось отменить', 'err');
  toast('Заказ отменён');
  renderHistory();
}

/* The bar is the whole cart, not a running total: both baskets are itemised
   with their own subtotals so nothing is hidden behind the tab you are not
   looking at. They stay separate documents — the sums never merge. */
function cartLines(which) {
  return [...carts[which].entries()].map(([id, qty]) => {
    const it = catalog.items.find((x) => x.id === id);
    return { id, qty, cost: it?.item_cost ?? 0, name: it?.item_name || `#${id}` };
  });
}

const sumOf = (lines) => lines.reduce((a, l) => a + l.cost * l.qty, 0);

function renderCart() {
  document.getElementById('cart')?.remove();

  // while editing, the other basket is not part of this document and must not
  // be sent along with it
  const groups = (editing
    ? [{ key: editing.kind, label: editing.kind === 'return' ? 'Возврат' : 'Заказ',
         lines: cartLines(editing.kind) }]
    : [
        { key: 'order', label: 'Заказ', lines: cartLines('order') },
        { key: 'return', label: 'Возврат', lines: cartLines('return') }
      ]).filter((g) => g.lines.length);

  if (!groups.length) {
    document.body.style.paddingBottom = '24px';
    return;
  }

  const bar = document.createElement('div');
  bar.className = 'cart';
  bar.id = 'cart';
  bar.innerHTML = `
    <div class="wrap">
      <div class="cart__list">
        ${groups.map((g) => `
          <div class="cart__group">
            <div class="cart__ghead">
              <span class="cart__gname ${g.key === 'return' ? 'is-return' : ''}">${g.label}</span>
              <span class="cart__gsum">${sumOf(g.lines)} ₽</span>
              <button class="cart__clear" data-clear="${g.key}" aria-label="Очистить ${g.label}">×</button>
            </div>
            ${g.lines.map((l) => `
              <div class="cart__line">
                <span class="cart__lname">${esc(l.name)}</span>
                <span class="cart__lqty">× ${l.qty}</span>
                <span class="cart__lsum">${l.cost * l.qty} ₽</span>
              </div>`).join('')}
          </div>`).join('')}
      </div>
      ${!editing && catalog.orders?.for_next_day
        ? '<div class="cart__note">Заказ будет учтён на следующий день</div>' : ''}
      <button class="btn" id="cart-send"
              ${catalog.orders?.ordering_blocked && !editing ? 'disabled' : ''}>
        ${submitLabel(groups)}</button>
    </div>`;
  document.body.append(bar);

  bar.querySelectorAll('[data-clear]').forEach((b) => {
    b.onclick = () => {
      carts[b.dataset.clear].clear();
      renderCatalog();
      paintTabCounts();
    };
  });
  document.getElementById('cart-send').onclick = submit;

  // the bar grows with its contents, so the page padding has to follow it
  document.body.style.paddingBottom = `${bar.offsetHeight + 16}px`;
}

function submitLabel(groups) {
  if (editing) return `Сохранить изменения #${editing.id}`;
  if (catalog.orders?.ordering_blocked) return 'Приём заказов закрыт';
  if (groups.length === 2) return 'Отправить заказ и возврат';
  return groups[0].key === 'return' ? 'Оформить возврат' : 'Оформить заказ';
}

/* Sending a basket is the one wait here worth covering the screen for: it can
   take two round trips, and nothing on the page behind it is safe to press
   while they are in the air. */
function blockScreen(label) {
  const el = document.createElement('div');
  el.className = 'splash splash--busy';
  el.innerHTML = loaderHTML({ size: 'md', count: 4, label });
  document.body.append(el);
  return () => el.remove();
}

/* One request per non-empty basket: an order and a return are separate
   documents and are confirmed separately by an admin. */
async function submit() {
  const btn = document.getElementById('cart-send');
  btn.disabled = true;
  const unblock = blockScreen(editing ? 'Сохраняем…' : 'Отправляем…');
  try {
    return await sendBaskets(btn);
  } finally {
    unblock();
  }
}

async function sendBaskets(btn) {
  if (editing) return saveEdit(btn);

  const jobs = ['order', 'return']
    .filter((k) => carts[k].size)
    .map((k) => ({ kind: k, items: [...carts[k].entries()].map(([id, qty]) => ({ id, qty })) }));

  const done = [];
  for (const job of jobs) {
    const { ok, status, data } = await post('/api/app/orders', job);
    if (!ok) {
      btn.disabled = false;
      // whatever already went through stays sent; only the rest is retried
      done.forEach((k) => carts[k].clear());
      // the cutoff passed while the basket was open — pick up the new rules
      // so the screen stops offering what the server will now refuse
      if (status === 409) await refreshRules();
      renderCatalog();
      paintTabCounts();
      return toast(data.error || 'Не удалось отправить', 'err');
    }
    carts[job.kind].clear();
    done.push(job.kind);
  }

  btn.disabled = false;
  toast(done.length === 2 ? 'Заказ и возврат отправлены'
        : done[0] === 'return' ? 'Возврат отправлен' : 'Заказ отправлен');

  screen = 'history';
  render();
}

/* The window can close between opening the app and pressing save, so a 409
   here is expected rather than exceptional: drop the edit and show the order
   as it stands. */
async function saveEdit(btn) {
  const items = [...carts[editing.kind].entries()].map(([id, qty]) => ({ id, qty }));
  const { ok, status, data } = await send('PATCH', `/api/app/orders/${editing.id}`, { items });
  btn.disabled = false;

  if (!ok) {
    toast(data.error || 'Не удалось сохранить', 'err');
    // the cutoff passed while the basket was open: show where things stand
    if (status === 409) { editing = null; screen = 'history'; render(); }
    return;
  }

  carts[editing.kind].clear();
  editing = null;
  toast('Изменения сохранены');
  screen = 'history';
  render();
}

let historyTimer = null;

async function renderHistory() {
  const body = document.getElementById('body');
  showLoader(body, { size: 'sm', count: 4 });
  document.getElementById('cart')?.remove();
  document.body.style.paddingBottom = '24px';

  let orders = [];
  try {
    orders = await get('/api/app/orders');
  } catch {
    body.innerHTML = `<div class="empty">Не удалось загрузить историю.</div>`;
    return;
  }

  if (!orders.length) {
    body.innerHTML = `<div class="empty">Заказов пока нет.</div>`;
    return;
  }

  paintHistory(orders);

  /* The deadline can pass while the screen is just sitting there — an app
     opened before it must not keep offering the buttons. The server refuses
     late edits anyway; this is so the offer disappears on its own. */
  clearInterval(historyTimer);
  historyTimer = setInterval(() => {
    if (screen !== 'history' || !document.getElementById('body')) {
      return clearInterval(historyTimer);
    }
    paintHistory(orders);
  }, 15000);
}

const BADGE = { new: ['badge--new', 'Новый'], confirmed: ['badge--ok', 'Подтверждён'],
                rejected: ['badge--no', 'Отклонён'] };

/* The server sent both the verdict and the deadline it used. Re-reading the
   clock here is what makes an app that has been open since this morning stop
   offering the buttons once the cutoff passes. */
const stillOpen = (o) =>
  !o.editable_until || Date.now() < Date.parse(o.editable_until);

const mayEdit = (o) => Boolean(o.can_edit) && stillOpen(o);
const mayDelete = (o) => Boolean(o.can_delete) && stillOpen(o);

const clock = (iso) => new Date(iso).toLocaleTimeString('ru-RU',
  { hour: '2-digit', minute: '2-digit' });

function deadlineNote(o) {
  if (!o.editable_until) {
    return o.status === 'new' && !catalog.orders?.allow_edit_confirmed
      ? 'Можно изменить, пока заказ не подтверждён'
      : 'Заказ можно изменить';
  }
  const sameDay = new Date(o.editable_until).toDateString() === new Date().toDateString();
  return `Можно изменить до ${clock(o.editable_until)}${sameDay ? '' : ' завтра'}`;
}

function paintHistory(orders) {
  const body = document.getElementById('body');
  if (!body) return;

  body.innerHTML = orders.map((o) => {
    const [cls, label] = BADGE[o.status] || ['', o.status];
    const lines = (Array.isArray(o.items) ? o.items : [])
      .map((l) => `${esc(l.name)} × ${l.qty}`).join('<br>');
    const edit = mayEdit(o);
    const del = mayDelete(o);
    return `
      <div class="order">
        <div class="order__head">
          <div class="order__id">${o.kind === 'return' ? 'Возврат' : 'Заказ'} #${o.id}</div>
          <span class="badge ${cls}">${esc(label)}</span>
        </div>
        <div class="order__lines">${lines || '—'}</div>
        <div class="order__total">${o.total ?? 0} ₽</div>
        ${o.edited_at ? '<div class="order__note">Заказ был изменён</div>' : ''}
        <div class="order__acts">
          ${edit ? `<button class="btn btn--sm" data-edit="${o.id}">Изменить</button>` : ''}
          ${del ? `<button class="btn btn--sm btn--ghost" data-del="${o.id}">Отменить</button>` : ''}
          ${o.returnable?.length
            ? `<button class="btn btn--sm btn--ghost" data-return="${o.id}">Вернуть</button>` : ''}
          <button class="btn btn--sm btn--ghost" data-repeat="${o.id}">Повторить</button>
        </div>
        <div class="order__note">${
          edit ? esc(deadlineNote(o))
          : o.status === 'rejected' ? ''
          : 'Заказ уже в работе — изменить нельзя'}</div>
      </div>`;
  }).join('');

  const byId = new Map(orders.map((o) => [String(o.id), o]));
  body.querySelectorAll('[data-edit]').forEach((b) => {
    b.onclick = () => startEdit(byId.get(b.dataset.edit));
  });
  body.querySelectorAll('[data-del]').forEach((b) => {
    b.onclick = () => deleteOrder(byId.get(b.dataset.del));
  });
  body.querySelectorAll('[data-repeat]').forEach((b) => {
    b.onclick = () => repeatOrder(byId.get(b.dataset.repeat));
  });
  body.querySelectorAll('[data-return]').forEach((b) => {
    b.onclick = () => openReturn(byId.get(b.dataset.return));
  });
}

/* ── return out of a past order ──────────────────────────────────────────
   Only reachable when Настройки puts returns behind the history. The picker
   is the order's own lines, each capped at what is still returnable, so the
   customer cannot ask for more back than they received. */

let returning = null;          // { order, picked: Map(id -> qty) }

function openReturn(order) {
  if (!order?.returnable?.length) return;
  returning = { order, picked: new Map() };
  screen = 'return';
  render();
}

function closeReturn() {
  returning = null;
  screen = 'history';
  render();
}

function renderReturn() {
  const body = document.getElementById('body');
  if (!body) return;
  const { order, picked } = returning;

  const total = order.returnable.reduce(
    (a, l) => a + l.cost * (picked.get(l.id) || 0), 0);
  const units = [...picked.values()].reduce((a, n) => a + n, 0);

  body.innerHTML = `
    <div class="editbar">
      <span>Возврат по заказу #${order.id}</span>
      <button class="editbar__cancel" id="ret-cancel" type="button">Отмена</button>
    </div>
    <div class="list">
      ${order.returnable.map((l) => {
        const qty = picked.get(l.id) || 0;
        return `
          <div class="item ${qty ? 'item--picked' : ''}">
            <div class="item__body">
              <div class="item__name">${esc(l.name)}</div>
              <div class="item__cost">${l.cost} ₽ · можно вернуть ${l.left} из ${l.qty}</div>
            </div>
            <div class="stepper ${qty ? '' : 'stepper--empty'}">
              <button class="stepper__minus" data-rminus="${l.id}" aria-label="Убрать">−</button>
              <span class="stepper__qty">${qty}</span>
              <button class="stepper__plus" data-rplus="${l.id}" aria-label="Добавить"
                      ${qty >= l.left ? 'disabled' : ''}>+</button>
            </div>
          </div>`;
      }).join('')}
    </div>`;

  body.querySelectorAll('[data-rplus]').forEach((b) => {
    b.onclick = () => bumpReturn(Number(b.dataset.rplus), +1);
  });
  body.querySelectorAll('[data-rminus]').forEach((b) => {
    b.onclick = () => bumpReturn(Number(b.dataset.rminus), -1);
  });
  body.querySelector('#ret-cancel').onclick = closeReturn;

  paintReturnBar(units, total);
}

function bumpReturn(id, delta) {
  const line = returning.order.returnable.find((l) => l.id === id);
  if (!line) return;
  const next = Math.max(0, Math.min(line.left, (returning.picked.get(id) || 0) + delta));
  if (next) returning.picked.set(id, next);
  else returning.picked.delete(id);
  renderReturn();
}

function paintReturnBar(units, total) {
  document.getElementById('cart')?.remove();
  if (!units) {
    document.body.style.paddingBottom = '24px';
    return;
  }

  const bar = document.createElement('div');
  bar.className = 'cart';
  bar.id = 'cart';
  bar.innerHTML = `
    <div class="wrap">
      <div class="cart__ghead">
        <span class="cart__gname is-return">Возврат по заказу #${returning.order.id}</span>
        <span class="cart__gsum">${total} ₽</span>
      </div>
      <button class="btn" id="ret-send">Оформить возврат · ${units} шт.</button>
    </div>`;
  document.body.append(bar);
  document.getElementById('ret-send').onclick = sendReturn;
  document.body.style.paddingBottom = `${bar.offsetHeight + 16}px`;
}

async function sendReturn() {
  const btn = document.getElementById('ret-send');
  btn.disabled = true;
  const unblock = blockScreen('Отправляем…');
  try {
    const items = [...returning.picked.entries()].map(([id, qty]) => ({ id, qty }));
    const { ok, data } = await post('/api/app/orders', {
      kind: 'return', source_order_id: returning.order.id, items
    });
    if (!ok) {
      btn.disabled = false;
      return toast(data.error || 'Не удалось отправить', 'err');
    }
    toast('Возврат отправлен');
    closeReturn();
  } finally {
    unblock();
  }
}

/* Every path through start() ends with a screen painted, so the splash comes
   off once it settles — including the failure paths, which have something to
   say and cannot say it from behind the loader. */
start()
  .catch(() => centered('Не удалось загрузить',
    'Проверьте соединение и откройте приложение снова.'))
  .finally(hideSplash);
