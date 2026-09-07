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
  // Visibility of the expand button is CSS's job (body.aside-compact), so
  // the narrow-viewport breakpoint gets it for free.
  const toggleCompact = () => { prefsMod.set({ compact: !prefs.compact }); buildAside(); };
  $('#nav-toggle').onclick = toggleCompact;
  $('#aside-expand').onclick = toggleCompact;

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
    const b = h(`<button class="aside__tab" role="tab" aria-selected="${t.id === asideTab}">${esc(t.label)}</button>`);
    b.onclick = () => { asideTab = t.id; buildAside(); };
    bar.append(b);
  });

  const body = $('#aside-body');
  body.innerHTML = '';
  body.append(tabs.find((t) => t.id === asideTab).render());
  paintIcons(body);
}

/* Global tab — present on every panel. */
const visualTab = {
  id: 'visual',
  label: 'Вид',
  render() {
    const el = h(`
      <div>
        <div class="field">
          <span class="field__label">Тема</span>
          <div class="seg" id="seg-theme">
            <button data-v="light" aria-pressed="${prefs.theme === 'light'}">Светлая</button>
            <button data-v="dark"  aria-pressed="${prefs.theme === 'dark'}">Тёмная</button>
          </div>
        </div>

        <div class="field" style="margin-bottom:0">
          <span class="field__label">Боковые панели</span>
          <div class="seg" id="seg-compact">
            <button data-v="full" aria-pressed="${!prefs.compact}">
              <span data-icon="panel-right"></span>Полные
            </button>
            <button data-v="compact" aria-pressed="${!!prefs.compact}">
              <span data-icon="panel-right"></span>Компактные
            </button>
          </div>
          <p class="hint">В компактном режиме обе панели сжимаются до одних иконок.</p>
        </div>
      </div>`);

    el.querySelectorAll('#seg-theme button').forEach((b) => {
      b.onclick = () => { prefsMod.set({ theme: b.dataset.v }); buildAside(); };
    });
    el.querySelectorAll('#seg-compact button').forEach((b) => {
      b.onclick = () => { prefsMod.set({ compact: b.dataset.v === 'compact' }); buildAside(); };
    });
    return el;
  }
};
