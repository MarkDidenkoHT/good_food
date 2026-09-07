/* Good Food mini-app. Two modes over one catalog: an order and a return
   differ only by the `kind` sent with the basket. Materials and their costs
   are never fetched here — customers see items and prices only. */

const tg = window.Telegram?.WebApp;
tg?.ready();
tg?.expand();

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
  orders: { edit_window_minutes: 0, allow_delete_new: false }
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
  return { ok: res.ok, status: res.status, data };
}

async function get(url) {
  const res = await fetch(url, { credentials: 'same-origin' });
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

/* Inside Telegram the signed initData identifies the user with no typing. In
   a plain browser there is nothing to verify, so the login form asks for the
   chat id and the company code instead. */
let chatId = null;

async function start() {
  const initData = tg?.initData || '';

  // An existing session outruns both paths.
  const session = await fetch('/api/auth/user/me', { credentials: 'same-origin' });
  if (session.ok) { me = await session.json(); return openApp(); }

  if (!initData) return renderLogin();

  const { ok, status, data } = await post('/api/auth/user/telegram', { initData });
  if (ok) { me = data; return openApp(); }

  if (status === 404) return centered('Вы ещё не зарегистрированы',
    'Откройте бота и нажмите /start, затем вернитесь сюда.');
  if (data.error === 'company_blocked') return centered('Доступ компании закрыт',
    'Свяжитесь с менеджером.');
  if (status === 403) return centered('Ожидайте подтверждения',
    'Менеджер откроет доступ — вы получите сообщение в Telegram.');
  if (status === 409) return renderJoin();      // known user, no company yet
  return renderLogin();
}

/* Browser login: chat id + company code. */
function renderLogin() {
  centered('Вход', 'Введите логин и пароль, выданные менеджером.', `
    <form id="login" style="text-align:left">
      <input id="chat" inputmode="numeric" maxlength="20" autocomplete="off"
             spellcheck="false" placeholder="Логин" required>
      <input class="code-input" id="code" maxlength="32" autocomplete="one-time-code"
             autocapitalize="off" spellcheck="false" placeholder="Пароль" required
             style="margin-top:10px">
      <button class="btn" type="submit" style="margin-top:12px">Войти</button>
      <div class="err" id="err"></div>
    </form>`);

  document.getElementById('login').onsubmit = (e) => {
    e.preventDefault();
    chatId = document.getElementById('chat').value.trim();
    submitJoin(document.getElementById('code').value.trim());
  };
}

function centered(title, text, extraHTML = '') {
  view.innerHTML = `
    <div class="center"><div class="center__box">
      <div class="mark">GF</div>
      <h1>${esc(title)}</h1>
      <p>${esc(text)}</p>
      ${extraHTML}
    </div></div>`;
}

/* Known user inside Telegram who has not joined a company yet. */
function renderJoin() {
  centered('Пароль компании', 'Введите пароль, выданный менеджером.', `
    <form id="join">
      <input class="code-input" id="code" maxlength="32" autocomplete="one-time-code"
             autocapitalize="off" spellcheck="false" placeholder="Пароль" required>
      <button class="btn" type="submit" style="margin-top:12px">Продолжить</button>
      <div class="err" id="err"></div>
    </form>`);

  document.getElementById('join').onsubmit = (e) => {
    e.preventDefault();
    submitJoin(document.getElementById('code').value.trim());
  };
}

async function submitJoin(code) {
  const err = document.getElementById('err');
  if (err) err.textContent = '';

  const payload = { code };
  if (tg?.initData) payload.initData = tg.initData;
  if (chatId) payload.chat_id = chatId;

  const { ok, status, data } = await post('/api/auth/user/join', payload);
  if (ok) { me = data; return openApp(); }

  const message =
    status === 404 ? 'Сначала нажмите /start в боте'
    : data.error === 'pending' ? 'Доступ ещё не открыт менеджером'
    : data.error === 'company_blocked' ? 'Доступ компании закрыт'
    : data.error || 'Неверный логин или пароль';

  if (err) err.textContent = message;
  else toast(message, 'err');
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
        </div>
        <div class="tabs">
          <button class="tab" data-screen="catalog" data-kind="order"
                  aria-selected="${screen === 'catalog' && kind === 'order'}"
                  ${editing && editing.kind !== 'order' ? 'disabled' : ''}>
            Заказ<span class="tab__count" data-count="order"></span>
          </button>
          <button class="tab" data-screen="catalog" data-kind="return"
                  aria-selected="${screen === 'catalog' && kind === 'return'}"
                  ${editing && editing.kind !== 'return' ? 'disabled' : ''}>
            Возврат<span class="tab__count" data-count="return"></span>
          </button>
          <button class="tab" data-screen="history"
                  aria-selected="${screen === 'history'}">История</button>
        </div>
      </div>
    </div>
    <div class="wrap" id="body"></div>`;

  view.querySelectorAll('.tab').forEach((b) => {
    b.onclick = () => {
      if (b.dataset.kind) kind = b.dataset.kind;
      screen = b.dataset.screen;
      render();
    };
  });

  paintTabCounts();

  if (screen === 'history') return renderHistory();
  renderCatalog();
}

/* Each tab shows how much is waiting in its own basket — the clearest way to
   say the two are not one list. */
function paintTabCounts() {
  document.querySelectorAll('.tab__count').forEach((el) => {
    const units = [...carts[el.dataset.count].values()].reduce((a, n) => a + n, 0);
    el.textContent = units || '';
    el.hidden = !units;
  });
}

function renderCatalog() {
  const body = document.getElementById('body');
  const items = catalog.items;

  if (!items.length) {
    body.innerHTML = `${editingBanner()}<div class="empty">Каталог пуст.</div>`;
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

  body.innerHTML = editingBanner() + html;
  body.querySelector('#edit-cancel')?.addEventListener('click', cancelEdit);
  body.querySelectorAll('[data-plus]').forEach((b) => {
    b.onclick = () => bump(Number(b.dataset.plus), +1);
  });
  body.querySelectorAll('[data-minus]').forEach((b) => {
    b.onclick = () => bump(Number(b.dataset.minus), -1);
  });
  renderCart();
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

async function deleteOrder(order) {
  if (!confirm(`Отменить ${order.kind === 'return' ? 'возврат' : 'заказ'} #${order.id}?`)) return;
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
      <button class="btn" id="cart-send">${submitLabel(groups)}</button>
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
  if (groups.length === 2) return 'Отправить заказ и возврат';
  return groups[0].key === 'return' ? 'Оформить возврат' : 'Оформить заказ';
}

/* One request per non-empty basket: an order and a return are separate
   documents and are confirmed separately by an admin. */
async function submit() {
  const btn = document.getElementById('cart-send');
  btn.disabled = true;

  if (editing) return saveEdit(btn);

  const jobs = ['order', 'return']
    .filter((k) => carts[k].size)
    .map((k) => ({ kind: k, items: [...carts[k].entries()].map(([id, qty]) => ({ id, qty })) }));

  const done = [];
  for (const job of jobs) {
    const { ok, data } = await post('/api/app/orders', job);
    if (!ok) {
      btn.disabled = false;
      // whatever already went through stays sent; only the rest is retried
      done.forEach((k) => carts[k].clear());
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
  const { ok, data } = await send('PATCH', `/api/app/orders/${editing.id}`, { items });
  btn.disabled = false;

  if (!ok) {
    if (data.error) toast(data.error, 'err');
    else toast('Не удалось сохранить', 'err');
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
  body.innerHTML = `<div class="empty">Загрузка…</div>`;
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

// The server sent both the verdict and the deadline it used; re-checking the
// clock here is what makes a long-open app behave like a freshly opened one.
const stillOpen = (o) =>
  Boolean(o.editable_until) && Date.now() < Date.parse(o.editable_until);

const mayEdit = (o) => Boolean(o.can_edit) && stillOpen(o);
const mayDelete = (o) => Boolean(o.can_delete) && stillOpen(o);

function leftLabel(o) {
  const ms = Date.parse(o.editable_until) - Date.now();
  const mins = Math.ceil(ms / 60000);
  if (mins >= 60) {
    const h = Math.floor(mins / 60);
    return `изменить можно ещё ${h} ч ${mins % 60} мин`;
  }
  return `изменить можно ещё ${mins} мин`;
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
        ${edit || del ? `
          <div class="order__acts">
            ${edit ? `<button class="btn btn--sm" data-edit="${o.id}">Изменить</button>` : ''}
            ${del ? `<button class="btn btn--sm btn--ghost" data-del="${o.id}">Отменить</button>` : ''}
            <span class="order__left">${esc(leftLabel(o))}</span>
          </div>` : (o.status === 'new' && catalog.orders?.edit_window_minutes
            ? '<div class="order__note">Заказ уже в работе — изменить нельзя.</div>' : '')}
      </div>`;
  }).join('');

  const byId = new Map(orders.map((o) => [String(o.id), o]));
  body.querySelectorAll('[data-edit]').forEach((b) => {
    b.onclick = () => startEdit(byId.get(b.dataset.edit));
  });
  body.querySelectorAll('[data-del]').forEach((b) => {
    b.onclick = () => deleteOrder(byId.get(b.dataset.del));
  });
}

start();
