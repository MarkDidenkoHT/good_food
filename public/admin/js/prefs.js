import { api } from './api.js';

const KEY = 'gf_admin_prefs';

export const defaults = {
  theme: 'light',   // light | dark
  compact: false    // both side panels collapse to icons together
};

export const prefs = { ...defaults };

/* localStorage first so the UI never flashes the wrong theme, then the
   server copy (shared across this admin's browsers) reconciles it. */
export function loadLocal() {
  try { Object.assign(prefs, JSON.parse(localStorage.getItem(KEY) || '{}')); } catch { /* ignore */ }
  apply();
}

export async function loadRemote() {
  try {
    const remote = await api.get('/api/admin/prefs');
    if (remote && Object.keys(remote).length) {
      Object.assign(prefs, remote);
      localStorage.setItem(KEY, JSON.stringify(prefs));
      apply();
    }
  } catch { /* prefs are a nicety — never block the panel on them */ }
}

let saveTimer;
export function set(patch) {
  Object.assign(prefs, patch);
  localStorage.setItem(KEY, JSON.stringify(prefs));
  apply();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { api.put('/api/admin/prefs', prefs).catch(() => {}); }, 500);
  document.dispatchEvent(new CustomEvent('prefs:change', { detail: prefs }));
}

export function apply() {
  document.documentElement.dataset.theme = prefs.theme === 'dark' ? 'dark' : 'light';
  document.body.classList.toggle('nav-compact', !!prefs.compact);
}
