import { api } from './api.js';

const KEY = 'gf_admin_prefs';

export const defaults = {
  theme: 'light',       // light | dark | system
  navCompact: false,
  asideCompact: false
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
  const dark = prefs.theme === 'dark' ||
    (prefs.theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.body.classList.toggle('nav-compact', !!prefs.navCompact);
  document.body.classList.toggle('aside-compact', !!prefs.asideCompact);
}

matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (prefs.theme === 'system') apply();
});
