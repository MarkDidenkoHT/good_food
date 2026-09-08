import { api, Unauthorized } from './api.js';
import { paintIcons, icon } from './icons.js';
import { h, esc, toast } from './ui.js';
import * as prefsMod from './prefs.js';
import { prefs } from './prefs.js';
import { hideSplash, veil } from '/loader.js';
import { usersPanel } from './panels/users.js';
import { itemsPanel } from './panels/items.js';
import { settingsPanel } from './panels/settings.js';
import { ordersPanel } from './panels/orders.js';
import { messagesPanel } from './panels/messages.js';
import { cronPanel } from './panels/placeholders.js';

/* Nav order. Users sits first while it is the only working panel; the final
   order is orders → items → users → settings → messages → cron. */
const panels = [ordersPanel, itemsPanel, usersPanel, settingsPanel, messagesPanel, cronPanel];

const $ = (sel) => document.querySelector(sel);
let current = null;

/* ── boot ───────────────────────────────────────────────────── */
prefsMod.loadLocal();
paintIcons();
start();

async function start() {
  try {
    await api.get('/api/auth/admin/me');
    await showShell();
  } catch (e) {
    if (e instanceof Unauthorized) showLogin();
    else toast(e.message, 'err');
  } finally {
    // whichever way boot went, the splash has done its job
    hideSplash();
  }
}

/* ── login ──────────────────────────────────────────────────── */
function showLogin() {
  $('#shell').hidden = true;
  $('#login').hidden = false;
  const form = $('#login-form');
  form.onsubmit = async (e) => {
    e.preventDefault();
    const err = $('#login-error');
    err.hidden = true;
    try {
      const fd = new FormData(form);
      await api.post('/api/auth/admin/login', {
        chat_id: fd.get('chat_id'),
        code: fd.get('code')
      });
      showShell();
    } catch (ex) {
      err.textContent = ex instanceof Unauthorized ? 'Неверный логин или пароль' : ex.message;
      err.hidden = false;
    }
  };
}

/* ── shell ──────────────────────────────────────────────────── */
async function showShell() {
  $('#login').hidden = true;
  $('#shell').hidden = false;

  buildNav();
  wireChrome();
  await prefsMod.loadRemote();

  const { panel, params } = parseHash();
  // awaited so the splash covers the first panel's own fetching too
  await navigate(panel || usersPanel, params);
}

function buildNav() {
  const list = $('#nav-list');
  list.innerHTML = '';
  panels.forEach((p) => {
    const li = h(`
      <li class="nav__item">
        <button class="nav__link" data-panel="${p.id}" title="${esc(p.label)}">
          <span class="nav__icon">${icon(p.icon)}</span>
          <span class="nav__label">${esc(p.label)}</span>
        </button>
      </li>`);
    li.querySelector('button').onclick = () => navigate(p);
    list.append(li);
  });
}

function wireChrome() {
  // one control for the nav width, at the foot of the nav itself
  $('#compact-btn').onclick = toggleCompact;
  $('#theme-btn').onclick = () =>
    setChrome({ theme: prefs.theme === 'dark' ? 'light' : 'dark' });
  paintChrome();

  $('#logout-btn').onclick = async () => {
    await api.post('/api/auth/admin/logout');
    location.reload();
  };

  window.addEventListener('hashchange', () => {
    const { panel, params } = parseHash();
    // re-navigate on a params-only change too: the same panel with a new
    // focus target still has work to do
    if (panel && (panel !== current || Object.keys(params).length)) navigate(panel, params);
  });
}

/* "#users?focus=4" -> { panel: usersPanel, params: { focus: '4' } } */
function parseHash() {
  const raw = location.hash.slice(1);
  const [id, qs = ''] = raw.split('?');
  return {
    panel: panels.find((p) => p.id === id) || null,
    params: Object.fromEntries(new URLSearchParams(qs))
  };
}

async function navigate(panel, params = {}) {
  // a panel that started something in the background (a poll, a timer) gets
  // told it is leaving, before its markup is thrown away
  if (current && current !== panel) current.destroy?.();
  current = panel;

  const qs = new URLSearchParams(params).toString();
  const want = qs ? `${panel.id}?${qs}` : panel.id;
  // assigning an identical hash is a no-op, so this cannot loop
  if (location.hash.slice(1) !== want) location.hash = want;

  document.querySelectorAll('.nav__link').forEach((b) => {
    if (b.dataset.panel === panel.id) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });

  $('#page-title').textContent = panel.title;
  $('#page-sub').textContent = panel.subtitle || '';

  const actions = $('#page-actions');
  actions.innerHTML = '';
  (panel.actions?.() || []).forEach((el) => actions.append(el));
  paintIcons(actions);

  // A panel appends its own frame and then fills it from the network, so the
  // loader goes over the top rather than into the container — the panel keeps
  // the root element it was handed, and nothing it looks up moves underneath
  // it while it works.
  const content = $('#content');
  content.innerHTML = '';
  const done = veil(content, { size: 'md', count: 5, label: 'Загрузка…', opaque: true });

  try {
    await panel.render(content, params);
  } catch (e) {
    if (e instanceof Unauthorized) { done(); return showLogin(); }
    toast(e.message, 'err');
  } finally {
    done();
  }
  paintIcons(content);
}

/* ── nav foot: width + theme ─────────────────────────────────── */

function toggleCompact() { setChrome({ compact: !prefs.compact }); }

function setChrome(patch) {
  prefsMod.set(patch);
  paintChrome();
}

/* Each foot button is a toggle, so it advertises what it will do next
   rather than what is currently on. */
function paintChrome() {
  const dark = prefs.theme === 'dark';

  const themeBtn = $('#theme-btn');
  themeBtn.querySelector('.nav__label').textContent = dark ? 'Светлая тема' : 'Тёмная тема';
  themeBtn.querySelector('.nav__icon').innerHTML = icon(dark ? 'sun' : 'moon');
  themeBtn.title = themeBtn.querySelector('.nav__label').textContent;

  const compactBtn = $('#compact-btn');
  compactBtn.querySelector('.nav__label').textContent =
    prefs.compact ? 'Развернуть меню' : 'Свернуть меню';
  compactBtn.querySelector('.nav__icon').innerHTML =
    icon(prefs.compact ? 'panel-left' : 'panel-right');
  compactBtn.title = compactBtn.querySelector('.nav__label').textContent;
}
