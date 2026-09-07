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
let catalog = { items: [], categories: [], group_by_category: false };
let kind = 'order';                 // order | return
let screen = 'catalog';             // catalog | history
const cart = new Map();             // itemId -> qty

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function post(url, body) {
  const res = await fetch(url, {
    method: 'POST',
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

async function start() {
  // initData is the only trustworthy identity; dev_chat_id is accepted by the
  // server outside production so the app can be opened in a desktop browser.
  const payload = { initData: tg?.initData || '' };
  const devId = new URLSearchParams(location.search).get('dev_chat_id');
  if (devId) payload.dev_chat_id = devId;

  const { ok, status, data } = await post('/api/auth/user/telegram', payload);

  if (ok) { me = data; return openApp(); }
  if (status === 404) return centered('Вы ещё не зарегистрированы',
    'Откройте бота и нажмите /start, затем вернитесь сюда.');
  if (status === 409) return renderJoin();
  if (data.error === 'company_blocked') return centered('Доступ компании закрыт',
    'Свяжитесь с менеджером.');
  if (status === 403) return centered('Ожидайте подтверждения',
    'Менеджер откроет доступ — вы получите сообщение в Telegram.');
  return centered('Не удалось войти', data.error || 'Попробуйте позже.');
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

function renderJoin() {
  centered('Код компании', 'Введите код, выданный менеджером.', `
    <form id="join">
      <input class="code-input" id="code" maxlength="32" autocomplete="one-time-code"
             autocapitalize="off" spellcheck="false" placeholder="XXXXXX" required>
      <button class="btn" type="submit" style="margin-top:12px">Продолжить</button>
      <div class="err" id="err"></div>
    </form>`);

  document.getElementById('join').onsubmit = async (e) => {
    e.preventDefault();
    const err = document.getElementById('err');
    err.textContent = '';
    const payload = { initData: tg?.initData || '', code: document.getElementById('code').value.trim() };
    const devId = new URLSearchParams(location.search).get('dev_chat_id');
    if (devId) payload.dev_chat_id = devId;

    const { ok, data } = await post('/api/auth/user/join', payload);
    if (!ok) { err.textContent = data.error === 'company_blocked' ? 'Доступ компании закрыт' : (data.error || 'Неверный код'); return; }
    me = data;
    openApp();
  };
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
      <div class="head__row">
        <div class="head__name">${esc(me.company_name || 'Компания')}</div>
        <div class="head__who">${esc(me.user_name || '')}</div>
      </div>
      <div class="tabs">
        <button class="tab" data-screen="catalog" data-kind="order"
                aria-selected="${screen === 'catalog' && kind === 'order'}">Заказ</button>
        <button class="tab" data-screen="catalog" data-kind="return"
                aria-selected="${screen === 'catalog' && kind === 'return'}">Возврат</button>
        <button class="tab" data-screen="history"
                aria-selected="${screen === 'history'}">История</button>
      </div>
    </div>
    <div id="body"></div>`;

  view.querySelectorAll('.tab').forEach((b) => {
    b.onclick = () => {
      const next = b.dataset.screen;
      // switching between order and return keeps the basket: the same goods
      // are usually involved, only the intent changes
      if (b.dataset.kind) kind = b.dataset.kind;
      screen = next;
      render();
    };
  });

  if (screen === 'history') return renderHistory();
  renderCatalog();
}

function renderCatalog() {
  const body = document.getElementById('body');
  const items = catalog.items;

  if (!items.length) {
    body.innerHTML = `<div class="empty">Каталог пуст.</div>`;
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
      html += `<div class="group__title">${esc(name)}</div>`;
      html += list.map(itemHTML).join('');
    }
  } else {
    html = items.map(itemHTML).join('');
  }

  body.innerHTML = html;
  body.querySelectorAll('[data-plus]').forEach((b) => {
    b.onclick = () => bump(Number(b.dataset.plus), +1);
  });
  body.querySelectorAll('[data-minus]').forEach((b) => {
    b.onclick = () => bump(Number(b.dataset.minus), -1);
  });
  renderCart();
}

function itemHTML(it) {
  const qty = cart.get(it.id) || 0;
  return `
    <div class="item">
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
  const next = (cart.get(id) || 0) + delta;
  if (next <= 0) cart.delete(id);
  else cart.set(id, Math.min(999, next));
  renderCatalog();
}

function renderCart() {
  document.getElementById('cart')?.remove();
  if (!cart.size) return;

  const lines = [...cart.entries()].map(([id, qty]) => {
    const it = catalog.items.find((x) => x.id === id);
    return { id, qty, cost: it?.item_cost ?? 0, name: it?.item_name || '' };
  });
  const total = lines.reduce((a, l) => a + l.cost * l.qty, 0);
  const units = lines.reduce((a, l) => a + l.qty, 0);

  const bar = document.createElement('div');
  bar.className = 'cart';
  bar.id = 'cart';
  bar.innerHTML = `
    <div class="cart__row">
      <div class="cart__sum">${total} ₽ <span class="cart__count">· ${units} шт.</span></div>
      <button class="btn btn--ghost" id="cart-clear" style="width:auto;padding:8px 14px">Очистить</button>
    </div>
    <button class="btn" id="cart-send">
      ${kind === 'return' ? 'Оформить возврат' : 'Оформить заказ'}
    </button>`;
  document.body.append(bar);

  document.getElementById('cart-clear').onclick = () => { cart.clear(); renderCatalog(); };
  document.getElementById('cart-send').onclick = submit;
}

async function submit() {
  const btn = document.getElementById('cart-send');
  btn.disabled = true;

  const items = [...cart.entries()].map(([id, qty]) => ({ id, qty }));
  const { ok, data } = await post('/api/app/orders', { kind, items });

  btn.disabled = false;
  if (!ok) return toast(data.error || 'Не удалось отправить', 'err');

  cart.clear();
  toast(kind === 'return' ? `Возврат #${data.id} отправлен` : `Заказ #${data.id} отправлен`);
  screen = 'history';
  render();
}

async function renderHistory() {
  const body = document.getElementById('body');
  body.innerHTML = `<div class="empty">Загрузка…</div>`;
  document.getElementById('cart')?.remove();

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

  const badge = { new: ['badge--new', 'Новый'], confirmed: ['badge--ok', 'Подтверждён'],
                  rejected: ['badge--no', 'Отклонён'] };

  body.innerHTML = orders.map((o) => {
    const [cls, label] = badge[o.status] || ['', o.status];
    const lines = (Array.isArray(o.items) ? o.items : [])
      .map((l) => `${esc(l.name)} × ${l.qty}`).join('<br>');
    return `
      <div class="order">
        <div class="order__head">
          <div class="order__id">${o.kind === 'return' ? 'Возврат' : 'Заказ'} #${o.id}</div>
          <span class="badge ${cls}">${esc(label)}</span>
        </div>
        <div class="order__lines">${lines || '—'}</div>
        <div class="order__total">${o.total ?? 0} ₽</div>
      </div>`;
  }).join('');
}

start();
