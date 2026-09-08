/* Sushi loader helpers, shared by the mini-app and the admin panel.
   Markup only — the animation lives in /loader.css. */

const KINDS = ['salmon', 'tamago', 'avocado', 'tuna', 'cucumber'];

/* `count` rolls, always taken from the front of the list so the colours stay
   in the same order whatever the size. */
export function rollsHTML(count = 5) {
  return KINDS.slice(0, Math.max(1, Math.min(count, KINDS.length)))
    .map((k) => `
      <div class="roll-wrap">
        <div class="shadow"></div>
        <div class="roll ${k}">
          <div class="roll-inner">
            <div class="nori"></div>
            <div class="rice"><div class="topping"></div></div>
          </div>
        </div>
      </div>`).join('');
}

/* size: 'sm' | 'md' | 'lg'. A label is optional — on a splash it says what is
   happening, inline it is usually noise. */
export function loaderHTML({ size = 'md', count = 5, label = '' } = {}) {
  const cls = size === 'lg' ? '' : `sushi--${size}`;
  return `
    <div class="sushi ${cls}">
      <div class="sushi__row">${rollsHTML(count)}</div>
      ${label ? `<div class="sushi__label">${label}</div>` : ''}
    </div>`;
}

/* Drops the loader into a container, replacing whatever was there. */
export function showLoader(el, opts) {
  if (!el) return;
  el.innerHTML = `<div class="sushi-block">${loaderHTML(opts)}</div>`;
}

/* A veil over content that is already on screen and is being refreshed. The
   container needs a positioning context; returns the remover.

   `opaque` hides what is underneath rather than dimming it — used when a
   panel is being swapped out, where the half-built screen below would only
   compete with the loader. */
export function veil(el, { opaque = false, ...opts } = {}) {
  if (!el) return () => {};
  const node = document.createElement('div');
  node.className = `sushi-veil${opaque ? ' sushi-veil--solid' : ''}`;
  node.innerHTML = loaderHTML({ size: 'sm', count: 3, ...opts });
  if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
  el.append(node);
  return () => node.remove();
}

/* ── boot splash ─────────────────────────────────────────────────────────
   The markup is in the HTML so it paints before any module loads; this only
   takes it away, and only once the first real screen is up. */

export function hideSplash() {
  const el = document.getElementById('splash');
  if (!el || el.dataset.going) return;
  el.dataset.going = '1';

  let fading = false;
  const fade = () => {
    if (fading) return;
    fading = true;
    el.classList.add('splash--out');
    setTimeout(() => el.remove(), 300);
  };

  // A frame first, so the screen underneath has painted before the fade
  // starts — but rAF never fires while the tab is in the background, and a
  // splash that outlives the app it was covering is worse than an abrupt
  // one. The timer is the guarantee; whichever arrives first wins.
  requestAnimationFrame(fade);
  setTimeout(fade, 150);
}
