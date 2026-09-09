import { paintIcons } from './icons.js';

/* ── tiny DOM helper ─────────────────────────────────────────── */
export function h(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  const node = t.content.firstElementChild;
  paintIcons(node);
  return node;
}

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ── toasts ──────────────────────────────────────────────────── */
export function toast(message, kind = 'ok') {
  const el = h(`<div class="toast ${kind === 'err' ? 'toast--err' : ''}">${esc(message)}</div>`);
  document.getElementById('toasts').append(el);
  setTimeout(() => el.remove(), 3200);
}

/* ── modal ───────────────────────────────────────────────────── */
/* Modals are opened and then wired up by the caller, so the caller needs a
   way to be told the dialog was dismissed without saving — used to clean up
   images uploaded into a form that was then cancelled. */
const cancelHooks = new WeakMap();
let currentModal = null;

export function onModalCancel(fn) {
  if (currentModal) cancelHooks.get(currentModal)?.(fn);
}

// onSubmit(formData, close) — return false to keep the modal open.
// `wide` gives a form room for two columns of fields.
export function modal({ title, bodyHTML, submitLabel = 'Сохранить', onSubmit, wide = false }) {
  const root = document.getElementById('modal-root');
  const el = h(`
    <div class="modal">
      <div class="modal__backdrop"></div>
      <form class="modal__box${wide ? ' modal__box--wide' : ''}">
        <div class="modal__head"><div class="modal__title">${esc(title)}</div></div>
        <div class="modal__body">${bodyHTML}</div>
        <div class="modal__foot">
          <button type="button" class="btn" data-cancel>Отмена</button>
          <button type="submit" class="btn btn--primary">${esc(submitLabel)}</button>
        </div>
      </form>
    </div>`);

  let cancelHook = null;
  cancelHooks.set(el, (fn) => { cancelHook = fn; });
  currentModal = el;

  let submitted = false;
  const close = () => {
    el.remove();
    document.removeEventListener('keydown', onKey);
    cancelHooks.delete(el);
    if (currentModal === el) currentModal = null;
    if (!submitted) cancelHook?.();
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };

  el.querySelector('[data-cancel]').onclick = close;
  el.querySelector('.modal__backdrop').onclick = close;
  document.addEventListener('keydown', onKey);

  el.querySelector('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.target).entries());
    const btn = e.target.querySelector('[type=submit]');
    btn.disabled = true;
    try {
      const keep = await onSubmit?.(data, close);
      if (keep !== false) { submitted = true; close(); }
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      btn.disabled = false;
    }
  });

  root.append(el);
  el.querySelector('input, select, textarea')?.focus();
  return { close };
}

export function confirmDialog(title, text, onYes, submitLabel = 'Удалить') {
  return modal({
    title,
    bodyHTML: `<p style="margin:0">${esc(text)}</p>`,
    submitLabel,
    onSubmit: onYes
  });
}

export const fmtDate = (iso) =>
  iso ? new Date(iso).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' }) : '—';
