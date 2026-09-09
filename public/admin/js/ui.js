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
  // Modals can stack (a form that asks to confirm before it saves), so closing
  // the top one has to hand the pointer back to the one underneath rather than
  // clear it — otherwise the outer form's cancel hook is silently lost.
  const parentModal = currentModal;
  currentModal = el;

  let submitted = false;
  const close = () => {
    el.remove();
    document.removeEventListener('keydown', onKey);
    cancelHooks.delete(el);
    if (currentModal === el) currentModal = parentModal;
    if (!submitted) cancelHook?.();
  };
  // with a dialog stacked on top, Escape must dismiss only the topmost one —
  // both listeners are live, so each checks whether it is the one on top
  const onKey = (e) => { if (e.key === 'Escape' && currentModal === el) close(); };

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
  paintSegs(el);
  el.querySelector('input, select, textarea')?.focus();
  return { close };
}

/* ── segmented controls ──────────────────────────────────────── */

/* Gives every .seg a thumb that slides between the options instead of the
   highlight simply appearing somewhere else.

   Driven by a MutationObserver on aria-pressed rather than by a click
   handler, so it is the state that moves the thumb, not the press. Anything
   that already flips aria-pressed — a click, a redraw, a value arriving from
   the server — animates for free, and nothing has to be rewired. */

/* Where each control's thumb was when its markup was last thrown away, keyed
   by the element's id. A panel that redraws itself builds a brand new .seg,
   and without this the thumb would simply appear at the new option: the
   redraw would eat the very animation it was meant to show. Starting the new
   thumb at the old position and letting it travel makes the re-render
   invisible, which is the point. */
const segMemory = new Map();

export function paintSegs(root = document) {
  root.querySelectorAll?.('.seg').forEach(initSeg);
}

function initSeg(seg) {
  if (seg.dataset.seg) return;
  seg.dataset.seg = '1';

  const thumb = document.createElement('span');
  thumb.className = 'seg__thumb';
  thumb.setAttribute('aria-hidden', 'true');
  seg.prepend(thumb);

  // A control with no id cannot be recognised across a redraw; it still
  // animates in place, it just cannot inherit a position.
  const id = seg.id || null;

  /* null while the control is not laid out — inside a closed dialog, or in a
     field that is hidden until some other setting is switched on. */
  const geometry = () => {
    const active = seg.querySelector('button[aria-pressed="true"]');
    if (!active || !active.offsetWidth) return null;
    return { left: active.offsetLeft, width: active.offsetWidth };
  };

  const place = (g, animate) => {
    if (!animate) thumb.style.transition = 'none';
    thumb.style.opacity = '1';
    thumb.style.left = `${g.left}px`;
    thumb.style.width = `${g.width}px`;
    if (!animate) {
      void thumb.offsetWidth;                 // commit before restoring
      thumb.style.transition = '';
    }
  };

  const move = (animate) => {
    const g = geometry();
    if (!g) { thumb.style.opacity = '0'; return; }
    place(g, animate);
    if (id) segMemory.set(id, g);
  };

  const now = geometry();
  const previous = id ? segMemory.get(id) : null;
  if (now && previous && (previous.left !== now.left || previous.width !== now.width)) {
    place(previous, false);                   // start where the old markup left off

    // A frame first, so the starting position is painted before the travel
    // begins — but rAF never fires while the tab is in the background, and a
    // thumb stranded under the wrong option is worse than one that arrives
    // without ceremony. Whichever comes first wins.
    let moved = false;
    const go = () => { if (!moved) { moved = true; move(true); } };
    requestAnimationFrame(go);
    setTimeout(go, 60);
  } else {
    move(false);
  }

  new MutationObserver(() => move(true))
    .observe(seg, { attributes: true, attributeFilter: ['aria-pressed'], subtree: true });

  // Covers the control being laid out for the first time, and the window
  // being resized under it.
  new ResizeObserver(() => move(false)).observe(seg);
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
