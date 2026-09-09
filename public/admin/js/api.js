// Thin fetch wrapper. Throws Unauthorized so the shell can bounce to login.
export class Unauthorized extends Error {}

async function request(method, url, body) {
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });

  if (res.status === 401) throw new Unauthorized('Not authenticated');

  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
}

/* ── GET cache ───────────────────────────────────────────────────────────
   The panels each re-fetch their own lists on every visit, which is what
   made moving between them feel slow. Reads are cached by URL so a second
   visit paints from memory; anything that writes throws the cache away, so
   a panel never shows what it just changed as it was before.

   Two more escapes: `fresh` on a single read (the refresh buttons) and a
   TTL, so a tab left open all morning is not still showing the morning. */

const TTL_MS = 60_000;
const cache = new Map();     // url -> { at, data }
const inflight = new Map();  // url -> Promise, so parallel callers share one request

/* Reads whose whole point is a fresh answer: the auth probe, and the code
   generator, which must never hand out the same code twice. */
const NEVER_CACHE = /\/(me|new-code)(\?|$)/;

export function invalidate(prefix) {
  if (!prefix) return cache.clear();
  for (const url of cache.keys()) if (url.startsWith(prefix)) cache.delete(url);
}

function get(url, { fresh = false } = {}) {
  if (NEVER_CACHE.test(url)) return request('GET', url);

  if (!fresh) {
    const hit = cache.get(url);
    if (hit && Date.now() - hit.at < TTL_MS) return Promise.resolve(hit.data);
    const pending = inflight.get(url);
    if (pending) return pending;
  }

  const p = request('GET', url)
    .then((data) => { cache.set(url, { at: Date.now(), data }); return data; })
    .finally(() => { if (inflight.get(url) === p) inflight.delete(url); });

  inflight.set(url, p);
  return p;
}

/* A write can touch anything (an item edit moves a category count, a user
   edit moves a company row), so the whole cache goes rather than guessing
   which keys are still good. */
function write(method, url, body) {
  return request(method, url, body).finally(() => invalidate());
}

/* Warm the cache before the shell is shown. Failures are swallowed on
   purpose: this is a head start, and a panel that opens for real will
   surface its own error. */
export function preload(urls) {
  return Promise.all([...new Set(urls)].map((u) => get(u).catch(() => null)));
}

export const api = {
  get,
  post:  (u, b) => write('POST', u, b),
  patch: (u, b) => write('PATCH', u, b),
  put:   (u, b) => write('PUT', u, b),
  del:   (u) => write('DELETE', u),
  preload,
  invalidate
};
