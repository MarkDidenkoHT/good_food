import { api } from '../api.js';
import { h, esc, toast, modal, confirmDialog, fmtDate } from '../ui.js';

let rows = [];
let query = '';
let showDisabled = true;
let root;

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

  async render(container) {
    root = container;
    root.append(h(`
      <div class="card">
        <div class="card__head">
          <div class="card__title">Список пользователей</div>
          <div style="flex:1 1 auto"></div>
          <div style="position:relative;width:260px">
            <input class="input" id="users-search" placeholder="Поиск по названию или коду" style="padding-left:34px">
            <span data-icon="search" style="position:absolute;left:10px;top:9px;width:18px;height:18px;color:var(--ink-3)"></span>
          </div>
        </div>
        <div id="users-table-wrap"></div>
      </div>`));

    const search = root.querySelector('#users-search');
    search.value = query;
    search.addEventListener('input', () => { query = search.value; draw(); });

    document.getElementById('users-add')?.addEventListener('click', () => openForm());
    document.getElementById('users-refresh')?.addEventListener('click', () => load());

    await load();
  },

  // right-panel tab specific to this page
  asideTabs: [{
    id: 'users-view',
    label: 'Таблица',
    icon: 'users',
    render() {
      const el = h(`
        <div>
          <div class="field">
            <span class="field__label">Отображение</span>
            <label class="switch">
              <span>Показывать отключённых</span>
              <input type="checkbox" id="pref-show-disabled" ${showDisabled ? 'checked' : ''}>
              <span class="switch__track"></span>
            </label>
            <p class="hint">Пользователи с выключенным доступом не смогут войти в мини-приложение.</p>
          </div>
          <div class="field">
            <span class="field__label">Сводка</span>
            <div class="pill">Всего: ${rows.length}</div>
            <div class="pill pill--on" style="margin-top:6px">Активных: ${rows.filter((r) => r.access).length}</div>
          </div>
        </div>`);
      el.querySelector('#pref-show-disabled').addEventListener('change', (e) => {
        showDisabled = e.target.checked;
        draw();
      });
      return el;
    }
  }]
};

async function load() {
  try {
    rows = await api.get('/api/admin/users');
    draw();
  } catch (e) {
    toast(e.message, 'err');
  }
}

function draw() {
  const wrap = root?.querySelector('#users-table-wrap');
  if (!wrap) return;

  const q = query.trim().toLowerCase();
  const list = rows
    .filter((r) => showDisabled || r.access)
    .filter((r) => !q || `${r.user_name || ''} ${r.user_code || ''}`.toLowerCase().includes(q));

  if (!list.length) {
    wrap.innerHTML = `<div class="card__body" style="color:var(--ink-3)">Ничего не найдено.</div>`;
    return;
  }

  wrap.innerHTML = `
    <table class="table">
      <thead><tr>
        <th style="width:60px">ID</th><th>Компания</th><th style="width:150px">Код</th>
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
}

function rowHTML(u) {
  return `
    <tr>
      <td class="num">${u.id}</td>
      <td style="font-weight:700">${esc(u.user_name || '—')}</td>
      <td><span class="code-cell" data-copy="${esc(u.user_code || '')}" style="cursor:pointer" title="Скопировать">${esc(u.user_code || '—')}</span></td>
      <td><span class="pill">${u.role === 'admin' ? 'Админ' : 'Владелец'}</span></td>
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
        <label class="field__label" for="f-role">Роль</label>
        <select class="input" id="f-role" name="role">
          <option value="owner" ${user?.role !== 'admin' ? 'selected' : ''}>Владелец — доступ к мини-приложению</option>
          <option value="admin" ${user?.role === 'admin' ? 'selected' : ''}>Админ — доступ к админ-панели</option>
        </select>
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
        role: data.role === 'admin' ? 'admin' : 'owner'
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
