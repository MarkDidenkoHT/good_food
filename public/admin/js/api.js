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

export const api = {
  get:   (u) => request('GET', u),
  post:  (u, b) => request('POST', u, b),
  patch: (u, b) => request('PATCH', u, b),
  put:   (u, b) => request('PUT', u, b),
  del:   (u) => request('DELETE', u)
};
