import { api } from '../api.js';
import { h, esc, toast, modal, confirmDialog, fmtDate } from '../ui.js';
import { paintIcons } from '../icons.js';
import { showLoader } from '/loader.js';

/* Рассылки: compose a message, pick who gets it, and keep the record.

   Two sub-tabs, because the two jobs want different shapes on screen: the
   composer is a form, the history is a table. History rows carry the counters
   the server updates while a send is running, so an in-flight broadcast is
   polled until it settles rather than left looking stuck. */

const MAX_TEXT = 1000;
const POLL_MS = 2000;

let rows = [];
let companies = [];
let users = [];
let tab = 'new';                 // new | history
let poll = null;
let root;

/* The composer keeps its state across a redraw and across a tab switch — a
   half-written message must survive a look at the history. */
let draft = { text: '', image_path: '', mode: 'all', company_ids: [], user_ids: [] };

const STATUS = {
  sending: ['Отправляется', 'pill--warn'],
  sent:    ['Отправлено', 'pill--on'],
  deleted: ['Удалено', 'pill--off']
};

const TARGET_STATUS = {
  pending: 'В очереди',
  sent:    'Доставлено',
  failed:  'Ошибка',
  deleted: 'Удалено'
};

const imageSrc = (path) => `/api/admin/images/view?path=${encodeURIComponent(path)}`;

export const messagesPanel = {
  id: 'messages',
  label: 'Сообщения',
  icon: 'messages',
  title: 'Сообщения',
  subtitle: 'Рассылки пользователям',

  actions: () => [
    h(`<button class="btn btn--ghost btn--icon" id="msg-refresh" title="Обновить"><span data-icon="refresh"></span></button>`)
  ],

  preload: () => ['/api/admin/broadcasts', '/api/admin/companies', '/api/admin/users'],

  async render(container) {
    root = container;
    root.append(h(`
      <div class="card">
        <div class="card__head">
          <div class="subtabs" id="msg-tabs" role="tablist"></div>
        </div>
        <div id="msg-body"></div>
      </div>`));

    document.getElementById('msg-refresh')?.addEventListener('click', () => load(true));
    await load();
  },

  // the shell calls this when another panel takes over
  destroy() {
    stopPoll();
  }
};

async function load(fresh = false) {
  showLoader(root?.querySelector('#msg-body'), { size: 'sm', count: 4 });
  try {
    [rows, companies, users] = await Promise.all([
      api.get('/api/admin/broadcasts', { fresh }),
      !fresh && companies.length
        ? Promise.resolve(companies)
        : api.get('/api/admin/companies', { fresh }),
      !fresh && users.length
        ? Promise.resolve(users)
        : api.get('/api/admin/users', { fresh })
    ]);
    draw();
  } catch (e) {
    toast(e.message, 'err');
  }
}

/* ── polling ─────────────────────────────────────────────────── */

/* Only while something is actually in flight: a quiet panel makes no
   requests. */
function syncPoll() {
  const busy = rows.some((r) => r.status === 'sending');
  if (busy && !poll) poll = setInterval(refreshRows, POLL_MS);
  if (!busy) stopPoll();
}

function stopPoll() {
  if (poll) clearInterval(poll);
  poll = null;
}

async function refreshRows() {
  try {
    rows = await api.get('/api/admin/broadcasts', { fresh: true });
    if (tab === 'history') drawHistory();
    syncPoll();
  } catch {
    stopPoll();
  }
}

/* ── chrome ──────────────────────────────────────────────────── */

function draw() {
  drawTabs();
  if (tab === 'history') drawHistory();
  else drawComposer();
  syncPoll();
}

function drawTabs() {
  const bar = root?.querySelector('#msg-tabs');
  if (!bar) return;
  const t = [['new', 'Новая рассылка'], ['history', `История (${rows.length})`]];
  bar.innerHTML = t.map(([id, label]) =>
    `<button class="subtab" role="tab" data-tab="${id}" aria-selected="${tab === id}">${esc(label)}</button>`).join('');
  bar.querySelectorAll('[data-tab]').forEach((b) => {
    b.onclick = () => { tab = b.dataset.tab; draw(); };
  });
}

/* ── composer ────────────────────────────────────────────────── */

function drawComposer() {
  const body = root?.querySelector('#msg-body');
  if (!body) return;

  const reachable = users.filter((u) => u.chat_id && u.access !== false);

  body.innerHTML = `
    <div class="card__body">
      <div class="field">
        <label class="field__label" for="msg-text">Текст сообщения</label>
        <textarea class="input" id="msg-text" rows="5" maxlength="${MAX_TEXT}"
                  placeholder="Что сообщить пользователям">${esc(draft.text)}</textarea>
        <p class="hint"><span id="msg-count">0</span> / ${MAX_TEXT} символов.
           Отправляется обычным текстом — разметка не поддерживается.</p>
      </div>

      <div class="field">
        <span class="field__label">Фото</span>
        <div class="imgpick">
          <div class="imgpick__preview" id="msg-preview">
            ${draft.image_path ? `<img src="${imageSrc(draft.image_path)}" alt="">` : '<span>нет</span>'}
          </div>
          <div class="imgpick__actions">
            <input type="file" id="msg-file" accept="image/jpeg,image/png,image/webp,image/gif" hidden>
            <button type="button" class="btn btn--sm" id="msg-choose">Загрузить</button>
            <button type="button" class="btn btn--sm" id="msg-clear"
                    ${draft.image_path ? '' : 'disabled'}>Убрать</button>
            <p class="hint" id="msg-hint">Одно фото, JPEG, PNG, WebP или GIF, до 5 МБ.
               С фото текст уходит подписью.</p>
          </div>
        </div>
      </div>

      <div class="field">
        <span class="field__label">Кому</span>
        <div class="seg" id="msg-mode">
          <button data-v="all"       aria-pressed="${draft.mode === 'all'}">Всем</button>
          <button data-v="companies" aria-pressed="${draft.mode === 'companies'}">Компаниям</button>
          <button data-v="users"     aria-pressed="${draft.mode === 'users'}">Отдельным людям</button>
        </div>
        <p class="hint">Получают только пользователи с открытым доступом,
           которые запускали бота.</p>
      </div>

      ${draft.mode === 'companies' ? pickerHTML(
        'msg-companies',
        companies.map((c) => ({
          id: c.id,
          label: c.company_name || `#${c.id}`,
          note: `${reachable.filter((u) => u.company_id === c.id).length} чел.`
        })),
        draft.company_ids) : ''}

      ${draft.mode === 'users' ? pickerHTML(
        'msg-users',
        reachable.map((u) => ({
          id: u.id,
          label: u.user_name || `#${u.id}`,
          note: u.companies?.company_name || '—'
        })),
        draft.user_ids) : ''}

      <div class="field" style="margin-bottom:0">
        <div class="row-actions" style="justify-content:flex-start;gap:12px">
          <button class="btn btn--primary" id="msg-send"><span data-icon="messages"></span>Отправить</button>
          <span class="hint" id="msg-recipients" style="margin:0">Считаем получателей…</span>
        </div>
      </div>
    </div>`;

  wireComposer();
  paintIcons(body);
  countRecipients();
}

/* A checkbox list rather than a multi-select: the counts next to each row are
   the whole point, and a native multi-select cannot show them. */
function pickerHTML(id, options, chosen) {
  if (!options.length) {
    return `<div class="field"><p class="hint">Некому отправлять — нет подходящих записей.</p></div>`;
  }
  return `
    <div class="field">
      <p class="picker__tools">
        <button type="button" class="linkbtn" data-all="${id}">Выбрать все</button> ·
        <button type="button" class="linkbtn" data-none="${id}">Снять выбор</button>
      </p>
      <div class="picker" id="${id}">
        ${options.map((o) => `
          <label class="picker__row">
            <input type="checkbox" value="${o.id}" ${chosen.includes(o.id) ? 'checked' : ''}>
            <span class="picker__label">${esc(o.label)}</span>
            <span class="picker__note">${esc(o.note)}</span>
          </label>`).join('')}
      </div>
    </div>`;
}

function wireComposer() {
  const body = root.querySelector('#msg-body');
  const text = body.querySelector('#msg-text');
  const count = body.querySelector('#msg-count');

  const paintCount = () => {
    count.textContent = text.value.length;
    count.style.color = text.value.length >= MAX_TEXT ? 'var(--danger)' : '';
  };
  paintCount();
  text.oninput = () => { draft.text = text.value; paintCount(); };

  body.querySelectorAll('#msg-mode button').forEach((b) => {
    b.onclick = () => { draft.mode = b.dataset.v; drawComposer(); };
  });

  const picker = body.querySelector('#msg-companies, #msg-users');
  if (picker) {
    const key = picker.id === 'msg-companies' ? 'company_ids' : 'user_ids';
    const read = () => {
      draft[key] = [...picker.querySelectorAll('input:checked')].map((i) => Number(i.value));
      countRecipients();
    };
    picker.onchange = read;
    body.querySelector(`[data-all="${picker.id}"]`).onclick = () => {
      picker.querySelectorAll('input').forEach((i) => { i.checked = true; });
      read();
    };
    body.querySelector(`[data-none="${picker.id}"]`).onclick = () => {
      picker.querySelectorAll('input').forEach((i) => { i.checked = false; });
      read();
    };
  }

  wireImage(body);
  body.querySelector('#msg-send').onclick = send;
}

function wireImage(body) {
  const file = body.querySelector('#msg-file');
  const preview = body.querySelector('#msg-preview');
  const hint = body.querySelector('#msg-hint');
  const clear = body.querySelector('#msg-clear');

  const show = (path) => {
    draft.image_path = path || '';
    clear.disabled = !path;
    preview.innerHTML = path ? `<img src="${imageSrc(path)}" alt="">` : '<span>нет</span>';
  };

  body.querySelector('#msg-choose').onclick = () => file.click();

  file.onchange = async () => {
    const f = file.files?.[0];
    if (!f) return;
    if (f.size > 5 * 1024 * 1024) { hint.textContent = 'Файл больше 5 МБ'; return; }

    hint.textContent = 'Загрузка…';
    try {
      // raw body, not multipart: one file and no form fields to encode
      const res = await fetch('/api/admin/images?folder=broadcasts', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': f.type },
        body: f
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Не удалось загрузить');

      // one photo per message: the previous upload is nobody's now
      if (draft.image_path) {
        api.del(`/api/admin/images?path=${encodeURIComponent(draft.image_path)}`).catch(() => {});
      }
      show(data.path);
      hint.textContent = 'Загружено.';
    } catch (e) {
      hint.textContent = e.message;
    } finally {
      file.value = '';
    }
  };

  clear.onclick = () => {
    if (draft.image_path) {
      api.del(`/api/admin/images?path=${encodeURIComponent(draft.image_path)}`).catch(() => {});
    }
    show('');
    hint.textContent = 'Фото убрано.';
  };
}

/* The server resolves the audience, so the number shown is the number that
   will actually be written down when Отправить is pressed. */
async function countRecipients() {
  const label = root?.querySelector('#msg-recipients');
  if (!label) return;
  try {
    const { count } = await api.post('/api/admin/broadcasts/preview', audience());
    label.textContent = count ? `Получателей: ${count}` : 'Никто не получит — выборка пуста';
    label.style.color = count ? '' : 'var(--danger)';
  } catch {
    label.textContent = '';
  }
}

const audience = () => ({
  mode: draft.mode,
  company_ids: draft.company_ids,
  user_ids: draft.user_ids
});

function send() {
  if (!draft.text.trim() && !draft.image_path) {
    return toast('Введите текст или добавьте фото', 'err');
  }

  const who = draft.mode === 'all' ? 'всем пользователям'
    : draft.mode === 'companies' ? `выбранным компаниям (${draft.company_ids.length})`
    : `выбранным пользователям (${draft.user_ids.length})`;

  confirmDialog(
    'Отправить рассылку',
    `Отправить сообщение ${who}? Его можно будет удалить из чатов позже.`,
    async () => {
      await api.post('/api/admin/broadcasts', {
        text: draft.text.trim(),
        image_path: draft.image_path || null,
        ...audience()
      });
      toast('Рассылка отправляется');
      draft = { text: '', image_path: '', mode: 'all', company_ids: [], user_ids: [] };
      tab = 'history';
      await load();
    },
    'Отправить'
  );
}

/* ── history ─────────────────────────────────────────────────── */

function drawHistory() {
  const body = root?.querySelector('#msg-body');
  if (!body) return;

  if (!rows.length) {
    body.innerHTML = `<div class="card__body" style="color:var(--ink-3)">
      Рассылок пока не было.</div>`;
    return;
  }

  body.innerHTML = `
    <table class="table">
      <thead><tr>
        <th style="width:60px">№</th><th style="width:150px">Когда</th>
        <th style="width:130px">Кто</th><th>Сообщение</th>
        <th style="width:150px">Кому</th><th style="width:150px">Доставка</th>
        <th style="width:130px">Статус</th><th style="width:150px"></th>
      </tr></thead>
      <tbody>${rows.map(rowHTML).join('')}</tbody>
    </table>`;

  body.querySelectorAll('[data-open]').forEach((b) => {
    b.onclick = () => openDetail(b.dataset.open);
  });
  body.querySelectorAll('[data-recall]').forEach((b) => {
    b.onclick = () => recall(rows.find((r) => String(r.id) === b.dataset.recall));
  });
  body.querySelectorAll('[data-del]').forEach((b) => {
    b.onclick = () => removeRow(rows.find((r) => String(r.id) === b.dataset.del));
  });

  paintIcons(body);
}

function audienceLabel(b) {
  const a = b.audience || {};
  if (a.mode === 'companies') {
    const names = (a.company_ids || [])
      .map((id) => companies.find((c) => c.id === id)?.company_name || `#${id}`);
    return names.length > 2 ? `${names.length} компаний` : (names.join(', ') || 'Компании');
  }
  if (a.mode === 'users') return `${(a.user_ids || []).length} чел.`;
  return 'Все пользователи';
}

function rowHTML(b) {
  const [label, cls] = STATUS[b.status] || [b.status, ''];
  const preview = (b.text || '').slice(0, 90);
  return `
    <tr>
      <td class="num">${b.id}</td>
      <td class="num">${fmtDate(b.created_at)}</td>
      <td>${esc(b.sent_by_name || '—')}</td>
      <td>
        ${b.image_path ? '<span class="chip">фото</span> ' : ''}
        ${preview ? esc(preview) + ((b.text || '').length > 90 ? '…' : '')
                  : '<span style="color:var(--ink-3)">без текста</span>'}
      </td>
      <td>${esc(audienceLabel(b))}</td>
      <td class="num">${b.delivered}/${b.recipients}${
        b.failed ? ` <span style="color:var(--danger)">· ${b.failed} ошиб.</span>` : ''}</td>
      <td><span class="pill ${cls}">${esc(label)}</span></td>
      <td><div class="row-actions">
        <button class="btn btn--sm" data-open="${b.id}">Подробно</button>
        ${b.status === 'sent'
          ? `<button class="btn btn--ghost btn--icon btn--sm" data-recall="${b.id}"
                     title="Удалить сообщение из чатов"><span data-icon="trash"></span></button>`
          : ''}
        ${b.status !== 'sending'
          ? `<button class="btn btn--ghost btn--icon btn--sm" data-del="${b.id}"
                     title="Удалить запись из истории"><span data-icon="close"></span></button>`
          : ''}
      </div></td>
    </tr>`;
}

async function openDetail(id) {
  let b;
  try {
    b = await api.get(`/api/admin/broadcasts/${id}`);
  } catch (e) {
    return toast(e.message, 'err');
  }

  const byStatus = (s) => b.targets.filter((t) => t.status === s).length;
  // an empty column headed «ошибка» reads as though something went wrong, so
  // it only appears when Telegram actually said something
  const anyError = b.targets.some((t) => t.error);

  modal({
    title: `Рассылка #${b.id}`,
    submitLabel: 'Закрыть',
    bodyHTML: `
      ${b.image_path ? `<div class="field">
        <img src="${imageSrc(b.image_path)}" alt=""
             style="max-width:100%;border-radius:var(--r-md)">
      </div>` : ''}

      <div class="field">
        <span class="field__label">Текст</span>
        <p style="margin:0;white-space:pre-wrap">${
          b.text ? esc(b.text) : '<span style="color:var(--ink-3)">без текста</span>'}</p>
      </div>

      <div class="field">
        <span class="field__label">Отправлено</span>
        <p class="hint" style="margin:0">
          ${esc(b.sent_by_name || '—')}, ${fmtDate(b.created_at)} ·
          ${esc(audienceLabel(b))} ·
          доставлено ${byStatus('sent')}, ошибок ${byStatus('failed')},
          удалено ${byStatus('deleted')}
        </p>
      </div>

      <div class="field" style="margin-bottom:0">
        <span class="field__label">Получатели</span>
        <div style="max-height:280px;overflow:auto">
          <table class="table">
            <thead><tr>
              <th>Пользователь</th><th style="width:130px">Статус</th>
              ${anyError ? '<th>Что ответил Telegram</th>' : ''}
            </tr></thead>
            <tbody>${b.targets.map((t) => `
              <tr>
                <td>${esc(t.user_name || `#${t.user_id ?? '—'}`)}</td>
                <td>${esc(TARGET_STATUS[t.status] || t.status)}</td>
                ${anyError ? `<td class="hint">${esc(t.error || '')}</td>` : ''}
              </tr>`).join('')}</tbody>
          </table>
        </div>
      </div>`
  });
}

function recall(b) {
  if (!b) return;
  confirmDialog(
    'Удалить сообщение из чатов',
    `Удалить сообщение рассылки #${b.id} у ${b.delivered} получателей? ` +
    'Telegram может отказать по старым сообщениям — такие останутся в чатах.',
    async () => {
      const { removed, kept } = await api.post(`/api/admin/broadcasts/${b.id}/recall`);
      toast(kept ? `Удалено: ${removed}, осталось: ${kept}` : `Удалено у ${removed} получателей`);
      await load();
    }
  );
}

function removeRow(b) {
  if (!b) return;
  confirmDialog(
    'Удалить запись',
    `Убрать рассылку #${b.id} из истории? Сообщения в чатах останутся, ` +
    'если их не удалить отдельно.',
    async () => {
      await api.del(`/api/admin/broadcasts/${b.id}`);
      toast('Запись удалена');
      await load();
    }
  );
}
