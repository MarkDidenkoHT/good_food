import { loaderHTML } from '/loader.js';

// Thin fetch wrapper. Throws Unauthorized so the shell can bounce to login.
export class Unauthorized extends Error {}

/* Every call in the panel goes through here, so this is the one place that
   knows whether anything is in flight. The topbar shows a small hop while
   something is — including refreshes and saves that never replace a whole
   screen and so have no loader of their own.

   A short delay before it appears keeps quick calls from flashing it. */
let inFlight = 0;
let showAt = null;

function paintBusy() {
  const slot = document.getElementById('busy');
  if (!slot) return;
  const on = inFlight > 0;
  if (on && !slot.firstChild) slot.innerHTML = loaderHTML({ size: 'sm', count: 3 });
  if (!on) slot.innerHTML = '';
  slot.hidden = !on;
}

function busyStart() {
  inFlight++;
  if (inFlight === 1) showAt = setTimeout(paintBusy, 250);
}

function busyEnd() {
  inFlight = Math.max(0, inFlight - 1);
  if (inFlight === 0) {
    clearTimeout(showAt);
    showAt = null;
    paintBusy();
  }
}

async function request(method, url, body) {
  busyStart();
  let res;
  try {
    res = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined
    });
  } finally {
    busyEnd();
  }

  if (res.status === 401) throw new Unauthorized('Not authenticated');

  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
}

export const api = {
  get:   (u) => request('GET', u),
  post:  (u, b) => request('POST', u, b),
  patch: (u, b) => request('PATCH', u, b),
  put:   (u, b) => request('PUT', u, b),
  del:   (u) => request('DELETE', u)
};
