import { api } from '../api.js';
import { h, esc, toast, modal, confirmDialog, fmtDate } from '../ui.js';

let rows = [];
let query = '';
let showDisabled = true;
let focusId = null;
let companies = [];
let tab = 'users';        // users | companies
let root;

const ROLE = { admin: 'Админ', owner: 'Владелец', employee: 'Сотрудник' };

export const usersPanel = {
  id: 'users',
  label: 'Пользователи',
  icon: 'users',
  title: 'Пользователи',
  subtitle: 'Компании и их коды доступа',

  actions: () => [
    h(`<button class="btn btn--ghost btn--icon" id="users-refresh" title="Обновить"><span data-icon="refresh"></span></button>`),
    h(`<button class="btn btn--primary" id="users-add"><span data-icon="plus"></span>Добавить</button>`)
  ],

  async render(container, params = {}) {
    root = container;
    focusId = params.focus || null;
    root.append(h(`
      <div class="card">
        <div class="card__head">
          <div class="subtabs" id="usr-tabs" role="tablist"></div>
          <div style="flex:1 1 auto"></div>
          <div style="position:relative;width:260px">
            <input class="input" id="users-search" placeholder="Поиск по названию, коду или chat id" style="padding-left:34px">
            <span data-icon="search" style="position:absolute;left:10px;top:9px;width:18px;height:18px;color:var(--ink-3)"></span>
          </div>
        </div>
        <div id="users-table-wrap"></div>
      </div>`));

    const search = root.querySelector('#users-search');
    search.value = query;
    search.addEventListener('input', () => { query = search.value; draw(); });

    document.getElementById('users-add')?.addEventListener('click', () =>
      (tab === 'companies' ? companyForm() : openForm()));
    document.getElementById('users-refresh')?.addEventListener('click', () => load());

    await load();
  }

};

async function load() {
  try {
    [rows, companies] = await Promise.all([
      api.get('/api/admin/users'),
      api.get('/api/admin/companies')
    ]);
    draw();
  } catch (e) {
    toast(e.message, 'err');
  }
}

function draw() {
  drawTabs();
  const wrap = root?.querySelector('#users-table-wrap');
  if (!wrap) return;

  if (tab === 'companies') return drawCompanies(wrap);

  const q = query.trim().toLowerCase();
  const list = rows
    .filter((r) => showDisabled || r.access)
    .filter((r) => !q ||
      `${r.user_name || ''} ${r.user_code || ''} ${r.chat_id ?? ''}`.toLowerCase().includes(q));

  if (!list.length) {
    wrap.innerHTML = `<div class="card__body" style="color:var(--ink-3)">Ничего не найдено.</div>`;
    return;
  }

  wrap.innerHTML = `
    <table class="table">
      <thead><tr>
        <th style="width:60px">ID</th><th>Компания</th><th style="width:150px">Код</th>
        <th style="width:130px">Chat ID</th>
        <th style="width:170px">Компания</th>
        <th style="width:110px">Роль</th>
        <th style="width:110px">Доступ</th><th style="width:150px">Последний вход</th>
        <th style="width:150px">Создан</th><th style="width:110px"></th>
      </tr></thead>
      <tbody>${list.map(rowHTML).join('')}</tbody>
    </table>`;

  wrap.querySelectorAll('[data-edit]').forEach((b) => {
    b.onclick = () => openForm(rows.find((r) => r.id == b.dataset.edit));
  });
  wrap.querySelectorAll('[data-del]').forEach((b) => {
    b.onclick = () => {
      const u = rows.find((r) => r.id == b.dataset.del);
      confirmDialog('Удалить пользователя', `Удалить «${u.user_name}»? Действие необратимо.`, async () => {
        await api.del(`/api/admin/users/${u.id}`);
        toast('Пользователь удалён');
        await load();
      });
    };
  });
  wrap.querySelectorAll('[data-copy]').forEach((b) => {
    b.onclick = () => { navigator.clipboard?.writeText(b.dataset.copy); toast('Код скопирован'); };
  });

  import('../icons.js').then((m) => m.paintIcons(wrap));
  applyFocus();
}

/* Arriving from the Telegram button: scroll the user into view and flash the
   row once. Consumed on first use so a redraw does not keep re-flashing. */
function applyFocus() {
  if (!focusId) return;
  const row = root?.querySelector(`#user-row-${CSS.escape(focusId)}`);

  // The user may be filtered out of the current view — say so rather than
  // silently doing nothing.
  if (!row) {
    if (rows.some((r) => String(r.id) === String(focusId))) {
      toast('Пользователь скрыт текущим фильтром', 'err');
    } else {
      toast('Пользователь не найден', 'err');
    }
    focusId = null;
    return;
  }

  focusId = null;
  row.scrollIntoView({ behavior: 'smooth', block: 'center' });
  row.classList.remove('row-flash');
  void row.offsetWidth;            // restart the animation if it is already on
  row.classList.add('row-flash');
}

function rowHTML(u) {
  return `
    <tr id="user-row-${u.id}">
      <td class="num">${u.id}</td>
      <td style="font-weight:700">${esc(u.user_name || '—')}</td>
      <td><span class="code-cell" data-copy="${esc(u.user_code || '')}" style="cursor:pointer" title="Скопировать">${esc(u.user_code || '—')}</span></td>
      <td class="num">${u.chat_id
        ? esc(String(u.chat_id))
        : '<span class="pill pill--off">нет</span>'}</td>
      <td>${u.companies?.company_name
        ? `<span class="pill">${esc(u.companies.company_name)}</span>`
        : '<span class="pill pill--off">нет</span>'}</td>
      <td><span class="pill">${ROLE[u.role] || u.role || '—'}</span></td>
      <td>${u.access ? '<span class="pill pill--on">Открыт</span>' : '<span class="pill pill--off">Закрыт</span>'}</td>
      <td class="num">${fmtDate(u.last_login)}</td>
      <td class="num">${fmtDate(u.created_at)}</td>
      <td><div class="row-actions">
        <button class="btn btn--ghost btn--icon btn--sm" data-edit="${u.id}" title="Изменить"><span data-icon="edit"></span></button>
        <button class="btn btn--ghost btn--icon btn--sm" data-del="${u.id}" title="Удалить"><span data-icon="trash"></span></button>
      </div></td>
    </tr>`;
}

function openForm(user) {
  const isNew = !user;
  modal({
    title: isNew ? 'Новый пользователь' : `Изменить: ${user.user_name}`,
    submitLabel: isNew ? 'Создать' : 'Сохранить',
    bodyHTML: `
      <div class="field">
        <label class="field__label" for="f-name">Название компании</label>
        <input class="input" id="f-name" name="user_name" required value="${esc(user?.user_name || '')}">
      </div>
      <div class="field">
        <label class="field__label" for="f-code">Код доступа</label>
        <div style="display:flex;gap:8px">
          <input class="input input--code" id="f-code" name="user_code" maxlength="32"
                 placeholder="AUTO" value="${esc(user?.user_code || '')}">
          <button type="button" class="btn" id="f-gen">Сгенерировать</button>
        </div>
        <p class="hint">Оставьте пустым — код будет сгенерирован автоматически.</p>
      </div>
      <div class="field">
        <label class="field__label" for="f-chat">Chat ID</label>
        <input class="input input--code" id="f-chat" name="chat_id" inputmode="numeric"
               maxlength="20" placeholder="312756470" value="${esc(user?.chat_id ?? '')}">
        <p class="hint">Заполняется автоматически, когда пользователь нажимает /start в боте.
           Администратору нужен для входа в панель.</p>
      </div>
      <div class="field">
        <label class="field__label" for="f-role">Роль</label>
        <select class="input" id="f-role" name="role">
          <option value="employee" ${user?.role === 'employee' ? 'selected' : ''}>Сотрудник</option>
          <option value="owner" ${user?.role === 'owner' ? 'selected' : ''}>Владелец</option>
          <option value="admin" ${user?.role === 'admin' ? 'selected' : ''}>Админ</option>
        </select>
      </div>
      <div class="field">
        <label class="field__label" for="f-company">Компания</label>
        <select class="input" id="f-company" name="company_id">
          <option value="">— без компании —</option>
          ${companies.map((c) => `
            <option value="${c.id}" ${user?.company_id === c.id ? 'selected' : ''}>
              ${esc(c.company_name)}
            </option>`).join('')}
        </select>
        <p class="hint">Без компании пользователь не сможет оформлять заказы.</p>
      </div>
      <div class="field" style="margin-bottom:0">
        <label class="switch">
          <span style="font-weight:700">Доступ разрешён</span>
          <input type="checkbox" name="access" ${user?.access !== false ? 'checked' : ''}>
          <span class="switch__track"></span>
        </label>
      </div>`,
    onSubmit: async (data) => {
      const payload = {
        user_name: data.user_name,
        user_code: (data.user_code || '').trim(),
        access: data.access === 'on',
        chat_id: (data.chat_id || '').trim() || null,
        company_id: data.company_id || null,
        role: data.role
      };
      if (isNew) {
        if (!payload.user_code) delete payload.user_code;
        await api.post('/api/admin/users', payload);
        toast('Пользователь создан');
      } else {
        await api.patch(`/api/admin/users/${user.id}`, payload);
        toast('Изменения сохранены');
      }
      await load();
    }
  });

  document.getElementById('f-gen').onclick = async () => {
    const role = document.getElementById('f-role').value;
    const { code } = await api.get(`/api/admin/users/new-code?role=${role}`);
    document.getElementById('f-code').value = code;
  };
}


function drawTabs() {
  const bar = root?.querySelector('#usr-tabs');
  if (!bar) return;
  const defs = [['users', `Пользователи (${rows.length})`],
                ['companies', `Компании (${companies.length})`]];
  bar.innerHTML = '';
  defs.forEach(([id, label]) => {
    const b = h(`<button class="subtab" role="tab" aria-selected="${id === tab}">${esc(label)}</button>`);
    b.onclick = () => { tab = id; query = ''; root.querySelector('#users-search').value = ''; draw(); };
    bar.append(b);
  });
}

function drawCompanies(wrap) {
  const q = query.trim().toLowerCase();
  const list = companies.filter((c) => !q ||
    `${c.company_name || ''} ${c.company_code || ''}`.toLowerCase().includes(q));

  if (!list.length) {
    wrap.innerHTML = `<div class="card__body" style="color:var(--ink-3)">Ничего не найдено.</div>`;
    return;
  }

  wrap.innerHTML = `
    <table class="table">
      <thead><tr>
        <th style="width:60px">ID</th><th>Компания</th><th style="width:150px">Код</th>
        <th style="width:120px">Сотрудников</th><th style="width:160px">Владелец</th>
        <th style="width:110px">Доступ</th><th style="width:110px"></th>
      </tr></thead>
      <tbody>${list.map((c) => {
        const staff = rows.filter((u) => u.company_id === c.id);
        const owner = staff.find((u) => u.role === 'owner');
        return `
        <tr>
          <td class="num">${c.id}</td>
          <td style="font-weight:700">${esc(c.company_name || '—')}</td>
          <td><span class="code-cell" data-copy="${esc(c.company_code || '')}" style="cursor:pointer" title="Скопировать">${esc(c.company_code || '—')}</span></td>
          <td class="num">${staff.length}</td>
          <td>${owner ? esc(owner.user_name || '—') : '<span class="pill pill--off">нет</span>'}</td>
          <td>${c.access !== false ? '<span class="pill pill--on">Открыт</span>' : '<span class="pill pill--off">Закрыт</span>'}</td>
          <td><div class="row-actions">
            <button class="btn btn--ghost btn--icon btn--sm" data-cedit="${c.id}" title="Изменить"><span data-icon="edit"></span></button>
            <button class="btn btn--ghost btn--icon btn--sm" data-cdel="${c.id}" title="Удалить"><span data-icon="trash"></span></button>
          </div></td>
        </tr>`; }).join('')}
      </tbody>
    </table>`;

  wrap.querySelectorAll('[data-cedit]').forEach((b) => {
    b.onclick = () => companyForm(companies.find((c) => String(c.id) === b.dataset.cedit));
  });
  wrap.querySelectorAll('[data-cdel]').forEach((b) => {
    b.onclick = () => {
      const c = companies.find((x) => String(x.id) === b.dataset.cdel);
      confirmDialog('Удалить компанию',
        `Удалить «${c.company_name}»? Сотрудники и заказы останутся, но потеряют привязку к компании.`,
        async () => {
          await api.del(`/api/admin/companies/${c.id}`);
          toast('Компания удалена');
          await load();
        });
    };
  });
  wrap.querySelectorAll('[data-copy]').forEach((b) => {
    b.onclick = () => { navigator.clipboard?.writeText(b.dataset.copy); toast('Код скопирован'); };
  });

  import('../icons.js').then((m) => m.paintIcons(wrap));
}

function companyForm(company) {
  const isNew = !company;
  modal({
    title: isNew ? 'Новая компания' : `Изменить: ${company.company_name}`,
    submitLabel: isNew ? 'Создать' : 'Сохранить',
    bodyHTML: `
      <div class="field">
        <label class="field__label" for="c-name">Название компании</label>
        <input class="input" id="c-name" name="company_name" required value="${esc(company?.company_name || '')}">
      </div>
      <div class="field">
        <label class="field__label" for="c-code">Код компании</label>
        <div style="display:flex;gap:8px">
          <input class="input input--code" id="c-code" name="company_code" maxlength="32"
                 placeholder="AUTO" value="${esc(company?.company_code || '')}">
          <button type="button" class="btn" id="c-gen">Сгенерировать</button>
        </div>
        <p class="hint">Этот код сотрудники вводят в мини-приложении, чтобы присоединиться к компании.</p>
      </div>
      <div class="field" style="margin-bottom:0">
        <label class="switch">
          <span style="font-weight:700">Доступ разрешён</span>
          <input type="checkbox" name="access" ${company?.access !== false ? 'checked' : ''}>
          <span class="switch__track"></span>
        </label>
      </div>`,
    onSubmit: async (d) => {
      const payload = {
        company_name: d.company_name,
        company_code: (d.company_code || '').trim(),
        access: d.access === 'on'
      };
      if (isNew) {
        if (!payload.company_code) delete payload.company_code;
        await api.post('/api/admin/companies', payload);
        toast('Компания создана');
      } else {
        await api.patch(`/api/admin/companies/${company.id}`, payload);
        toast('Сохранено');
      }
      await load();
    }
  });

  document.getElementById('c-gen').onclick = async () => {
    const { code } = await api.get('/api/admin/users/new-code');
    document.getElementById('c-code').value = code;
  };
}
