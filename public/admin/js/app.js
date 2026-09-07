import { api, Unauthorized } from './api.js';
import { paintIcons, icon } from './icons.js';
import { h, esc, toast } from './ui.js';
import * as prefsMod from './prefs.js';
import { prefs } from './prefs.js';
import { usersPanel } from './panels/users.js';
import { itemsPanel } from './panels/items.js';
import { settingsPanel } from './panels/settings.js';
import { ordersPanel, messagesPanel, cronPanel } from './panels/placeholders.js';

/* Nav order. Users sits first while it is the only working panel; the final
   order is orders → items → users → settings → messages → cron. */
const panels = [ordersPanel, itemsPanel, usersPanel, settingsPanel, messagesPanel, cronPanel];

const $ = (sel) => document.querySelector(sel);
let current = null;
let asideTab = 'visual';

/* ── boot ───────────────────────────────────────────────────── */
prefsMod.loadLocal();
paintIcons();
start();

async function start() {
  try {
    await api.get('/api/auth/admin/me');
    showShell();
  } catch (e) {
    if (e instanceof Unauthorized) showLogin();
    else toast(e.message, 'err');
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
      await api.post('/api/auth/admin/login', { code: fd.get('code') });
      showShell();
    } catch (ex) {
      err.textContent = ex instanceof Unauthorized ? 'Неверный код' : ex.message;
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

  const fromHash = panels.find((p) => p.id === location.hash.slice(1));
  navigate(fromHash || usersPanel);
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
  $('#nav-toggle').onclick = () => { prefsMod.set({ compact: !prefs.compact }); buildAside(); };

  $('#logout-btn').onclick = async () => {
    await api.post('/api/auth/admin/logout');
    location.reload();
  };

  window.addEventListener('hashchange', () => {
    const p = panels.find((x) => x.id === location.hash.slice(1));
    if (p && p !== current) navigate(p);
  });
}

async function navigate(panel) {
  current = panel;
  location.hash = panel.id;

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

  const content = $('#content');
  content.innerHTML = '';
  try {
    await panel.render(content);
  } catch (e) {
    if (e instanceof Unauthorized) return showLogin();
    toast(e.message, 'err');
  }
  paintIcons(content);

  buildAside();
}

/* ── right accessibility panel ──────────────────────────────── */
function buildAside() {
  const tabs = [visualTab, ...(current.asideTabs || [])];
  if (!tabs.some((t) => t.id === asideTab)) asideTab = tabs[0].id;

  const bar = $('#aside-tabs');
  bar.innerHTML = '';
  tabs.forEach((t) => {
    const b = h(`
      <button class="aside__tab" role="tab" aria-selected="${t.id === asideTab}" title="${esc(t.label)}">
        <span class="aside__icon">${icon(t.icon || 'sliders')}</span>
        <span class="aside__label">${esc(t.label)}</span>
      </button>`);
    b.onclick = () => { asideTab = t.id; buildAside(); };
    bar.append(b);
  });

  const body = $('#aside-body');
  body.innerHTML = '';
  body.append(tabs.find((t) => t.id === asideTab).render());
  paintIcons(body);
}

/* Global tab — present on every panel. Two toggles, each shaped like a nav
   link so the panel collapses to icons the same way the nav does. */
const visualTab = {
  id: 'visual',
  label: 'Вид',
  icon: 'sliders',
  render() {
    const dark = prefs.theme === 'dark';
    const el = h(`
      <div>
        <button class="aside-row" id="row-compact"
                title="${prefs.compact ? 'Развернуть панели' : 'Свернуть панели'}">
          <span class="aside-row__icon">${icon(prefs.compact ? 'panel-left' : 'panel-right')}</span>
          <span class="aside-row__label">${prefs.compact ? 'Развернуть панели' : 'Свернуть панели'}</span>
        </button>
        <button class="aside-row" id="row-theme"
                title="${dark ? 'Светлая тема' : 'Тёмная тема'}">
          <span class="aside-row__icon">${icon(dark ? 'sun' : 'moon')}</span>
          <span class="aside-row__label">${dark ? 'Светлая тема' : 'Тёмная тема'}</span>
        </button>
      </div>`);

    el.querySelector('#row-compact').onclick = () => {
      prefsMod.set({ compact: !prefs.compact });
      buildAside();
    };
    el.querySelector('#row-theme').onclick = () => {
      prefsMod.set({ theme: prefs.theme === 'dark' ? 'light' : 'dark' });
      buildAside();
    };
    return el;
  }
};
