import { api } from '../api.js';
import { h, esc, toast, modal, confirmDialog, fmtDate } from '../ui.js';
import { paintIcons } from '../icons.js';

/* Уведомления: messages the bot sends again and again on a weekly timetable.

   The people who use this panel do not know the word cron and should never
   need to. A reminder is a sentence they can read back — «Ежедневное
   уведомление о заказе, пн–пт в 16:00, всем» — so the row says exactly that,
   and the form asks for nothing else: a name, the days, a time, the text, who
   gets it, and a switch.

   The schedule is checked every five minutes, which is the one piece of
   machinery worth admitting to: it is why a time is honoured to the nearest
   five minutes rather than to the second. */

const MAX_TEXT = 1000;
const TICK_MIN = 5;
const MAX_ATTEMPTS = 3;   // matches src/lib/reminders.js

/* ISO weekday numbers, Monday first — the order the days are read in here. */
const WEEK = [
  [1, 'Пн', 'понедельник'], [2, 'Вт', 'вторник'], [3, 'Ср', 'среда'],
  [4, 'Чт', 'четверг'], [5, 'Пт', 'пятница'], [6, 'Сб', 'суббота'],
  [7, 'Вс', 'воскресенье']
];

const PRESETS = [
  ['Каждый день', [1, 2, 3, 4, 5, 6, 7]],
  ['Будни', [1, 2, 3, 4, 5]],
  ['Выходные', [6, 7]]
];

const RUN_STATUS = {
  sent:    ['Отправлено', 'pill--on'],
  pending: ['Отправляется', 'pill--warn'],
  failed:  ['Ошибка', 'pill--off'],
  skipped: ['Пропущено', 'pill--off']
};

let rows = [];
let runs = [];
let companies = [];
let users = [];
let tab = 'list';                 // list | history
let root;

export const remindersPanel = {
  id: 'reminders',
  label: 'Уведомления',
  icon: 'cron',
  title: 'Уведомления',
  subtitle: 'Сообщения по расписанию',

  actions: () => [
    h(`<button class="btn btn--ghost btn--icon" id="rem-refresh" title="Обновить"><span data-icon="refresh"></span></button>`),
    h(`<button class="btn btn--primary" id="rem-add"><span data-icon="plus"></span>Добавить</button>`)
  ],

  preload: () => ['/api/admin/reminders', '/api/admin/reminder-runs',
                  '/api/admin/companies', '/api/admin/users'],

  async render(container) {
    root = container;
    root.append(h(`
      <div class="card">
        <div class="card__head">
          <div class="subtabs" id="rem-tabs" role="tablist"></div>
        </div>
        <div id="rem-wrap"></div>
      </div>`));

    document.getElementById('rem-add')?.addEventListener('click', () => openForm());
    document.getElementById('rem-refresh')?.addEventListener('click', () => load(true));

    await load();
  }
};

async function load(fresh = false) {
  try {
    [rows, runs, companies, users] = await Promise.all([
      api.get('/api/admin/reminders', { fresh }),
      api.get('/api/admin/reminder-runs', { fresh }),
      api.get('/api/admin/companies', { fresh }),
      api.get('/api/admin/users', { fresh })
    ]);
    draw();
  } catch (e) {
    toast(e.message, 'err');
  }
}

/* ── reading a schedule back ─────────────────────────────────── */

const reachable = () => users.filter((u) => u.chat_id && u.access !== false);

/* «пн–пт» when the days run together, «пн, ср, пт» when they do not: the
   short form is what someone actually says out loud. */
function daysText(days = []) {
  const list = [...days].map(Number).filter((d) => d >= 1 && d <= 7).sort((a, b) => a - b);
  if (!list.length) return '—';
  if (list.length === 7) return 'каждый день';

  const short = (d) => WEEK[d - 1][1].toLowerCase();
  const runs = [];
  for (const d of list) {
    const last = runs[runs.length - 1];
    if (last && d === last[last.length - 1] + 1) last.push(d);
    else runs.push([d]);
  }
  return runs
    .map((r) => (r.length >= 3 ? `${short(r[0])}–${short(r[r.length - 1])}` : r.map(short).join(', ')))
    .join(', ');
}

function audienceText(a = {}) {
  if (a.mode === 'kitchen') return 'группе кухни';
  if (a.mode === 'companies') {
    const names = (a.company_ids || [])
      .map((id) => companies.find((c) => c.id === id)?.company_name)
      .filter(Boolean);
    if (!names.length) return 'компаниям (не выбрано)';
    return names.length <= 2 ? names.join(', ') : `${names.length} компаний`;
  }
  if (a.mode === 'users') {
    const n = (a.user_ids || []).length;
    if (!n) return 'людям (не выбрано)';
    if (n === 1) {
      const u = users.find((x) => x.id === a.user_ids[0]);
      return u?.user_name || '1 человек';
    }
    return `${n} чел.`;
  }
  return 'всем';
}

/* How many people this reminder would actually reach right now. Counted the
   same way the send counts, so the number on screen is the number sent. */
function audienceCount(a = {}) {
  const list = reachable();
  if (a.mode === 'companies') {
    const ids = new Set(a.company_ids || []);
    return list.filter((u) => ids.has(u.company_id)).length;
  }
  if (a.mode === 'users') {
    const ids = new Set(a.user_ids || []);
    return list.filter((u) => ids.has(u.id)).length;
  }
  return list.length;
}

/* ── table ───────────────────────────────────────────────────── */

function draw() {
  drawTabs();
  const wrap = root?.querySelector('#rem-wrap');
  if (!wrap) return;
  if (tab === 'history') return drawHistory(wrap);

  if (!rows.length) {
    wrap.innerHTML = `
      <div class="card__body" style="color:var(--ink-3)">
        <p style="margin:0 0 6px">Уведомлений пока нет.</p>
        <p class="hint" style="margin:0">Уведомление — это сообщение, которое бот отправляет
           сам, в выбранные дни и время. Например: «Не забудьте оформить заказ»
           по будням в 16:00.</p>
      </div>`;
    return;
  }

  wrap.innerHTML = `
    <table class="table">
      <thead><tr>
        <th style="width:60px">ID</th>
        <th style="width:230px">Название</th>
        <th style="width:170px">Дни</th>
        <th style="width:80px">Время</th>
        <th>Текст</th>
        <th style="width:150px">Кому</th>
        <th style="width:110px">Статус</th>
        <th style="width:150px">Отправлено</th>
        <th style="width:170px"></th>
      </tr></thead>
      <tbody>${rows.map(rowHTML).join('')}</tbody>
    </table>`;

  wrap.querySelectorAll('[data-edit]').forEach((b) => {
    b.onclick = () => openForm(rows.find((r) => r.id == b.dataset.edit));
  });
  wrap.querySelectorAll('[data-toggle]').forEach((b) => {
    b.onclick = () => toggle(rows.find((r) => r.id == b.dataset.toggle));
  });
  wrap.querySelectorAll('[data-test]').forEach((b) => {
    b.onclick = () => sendNow(rows.find((r) => r.id == b.dataset.test));
  });
  wrap.querySelectorAll('[data-del]').forEach((b) => {
    b.onclick = () => {
      const r = rows.find((x) => x.id == b.dataset.del);
      confirmDialog('Удалить уведомление',
        `Удалить «${r.name}»? Оно перестанет отправляться. Действие необратимо.`,
        async () => {
          await api.del(`/api/admin/reminders/${r.id}`);
          toast('Уведомление удалено');
          await load(true);
        });
    };
  });

  paintIcons(wrap);
}

function drawTabs() {
  const bar = root?.querySelector('#rem-tabs');
  if (!bar) return;
  const defs = [['list', `Уведомления (${rows.length})`],
                ['history', `История (${runs.length})`]];
  bar.innerHTML = '';
  defs.forEach(([id, label]) => {
    const b = h(`<button class="subtab" role="tab" aria-selected="${id === tab}">${esc(label)}</button>`);
    b.onclick = () => { tab = id; draw(); };
    bar.append(b);
  });
}

/* ── history ─────────────────────────────────────────────────── */

/* One row per reminder per day — the same rows the schedule itself reads to
   decide what still needs doing. An «Ошибка» here is not just a record: the
   next check will try that send again, and a second row does not appear
   because a retry updates the day's row rather than adding one. */
function drawHistory(wrap) {
  if (!runs.length) {
    wrap.innerHTML = `
      <div class="card__body" style="color:var(--ink-3)">
        <p style="margin:0 0 6px">Отправок пока не было.</p>
        <p class="hint" style="margin:0">Здесь появится по строке на каждое уведомление
           за каждый день: во сколько оно должно было уйти, ушло ли, и скольким
           людям дошло.</p>
      </div>`;
    return;
  }

  wrap.innerHTML = `
    <table class="table">
      <thead><tr>
        <th style="width:110px">Дата</th>
        <th style="width:90px">План</th>
        <th style="width:250px">Уведомление</th>
        <th style="width:130px">Статус</th>
        <th style="width:100px">Попыток</th>
        <th style="width:170px">Доставлено</th>
        <th>Примечание</th>
        <th style="width:150px">Завершено</th>
      </tr></thead>
      <tbody>${runs.map(runHTML).join('')}</tbody>
    </table>
    <div class="card__body" style="border-top:1px solid var(--line)">
      <p class="hint" style="margin:0">Если отправка не удалась, следующая проверка
         (через ${TICK_MIN} минут) повторит её — до ${MAX_ATTEMPTS} попыток в течение часа
         после назначенного времени. Отправка кнопкой «Отправить сейчас» сюда не
         попадает — она видна в разделе «Сообщения».</p>
    </div>`;
}

function runHTML(r) {
  const [label, cls] = RUN_STATUS[r.status] || [r.status, ''];
  const retried = r.attempts > 1;
  return `
    <tr>
      <td class="num">${esc(r.run_on || '—')}</td>
      <td class="num">${esc(r.scheduled_at || '—')}</td>
      <td style="font-weight:700">${esc(r.reminder_name || `#${r.reminder_id}`)}</td>
      <td><span class="pill ${cls}">${esc(label)}</span></td>
      <td class="num">${r.attempts}${retried ? ' <span class="pill pill--warn">повтор</span>' : ''}</td>
      <td class="num">${r.status === 'sent'
        ? `${r.delivered} / ${r.recipients}${r.failed ? ` · ошибок ${r.failed}` : ''}`
        : '—'}</td>
      <td style="color:var(--ink-3)">${esc(r.error || '')}</td>
      <td class="num">${r.finished_at ? fmtDate(r.finished_at) : '—'}</td>
    </tr>`;
}

function rowHTML(r) {
  const count = audienceCount(r.audience);
  return `
    <tr>
      <td class="num">${r.id}</td>
      <td style="font-weight:700">${esc(r.name)}</td>
      <td>${esc(daysText(r.days))}</td>
      <td class="num">${esc(r.time_of_day || '—')}</td>
      <td style="color:var(--ink-2)">${esc(isKitchen(r) ? 'Список на приготовление' : preview(r.text))}</td>
      <td>
        <span class="pill">${esc(audienceText(r.audience))}</span>
        <div class="hint" style="margin:4px 0 0">${isKitchen(r) ? 'заказы на сегодня' : `${count} чел.`}</div>
      </td>
      <td><button type="button" class="pill pill--btn ${r.enabled ? 'pill--on' : 'pill--off'}"
                  data-toggle="${r.id}" title="${r.enabled ? 'Нажмите, чтобы выключить' : 'Нажмите, чтобы включить'}">
        ${r.enabled ? 'Включено' : 'Выключено'}</button></td>
      <td class="num">${r.last_run_at ? fmtDate(r.last_run_at) : '—'}</td>
      <td><div class="row-actions">
        <button class="btn btn--ghost btn--icon btn--sm" data-test="${r.id}"
                title="Отправить сейчас"><span data-icon="messages"></span></button>
        <button class="btn btn--ghost btn--icon btn--sm" data-edit="${r.id}"
                title="Изменить"><span data-icon="edit"></span></button>
        <button class="btn btn--ghost btn--icon btn--sm" data-del="${r.id}"
                title="Удалить"><span data-icon="trash"></span></button>
      </div></td>
    </tr>`;
}

const preview = (text) => {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t.length > 70 ? `${t.slice(0, 69)}…` : t || '—';
};

/* ── actions ─────────────────────────────────────────────────── */

async function toggle(r) {
  try {
    await api.patch(`/api/admin/reminders/${r.id}`, { enabled: !r.enabled });
    toast(r.enabled ? 'Уведомление выключено' : 'Уведомление включено');
    await load(true);
  } catch (e) {
    toast(e.message, 'err');
  }
}

/* Sending by hand is the only way to see what users will get without waiting
   for the schedule, so it is worth a confirmation with the count in it. */
const isKitchen = (r) => r?.audience?.mode === 'kitchen';

function sendNow(r) {
  if (isKitchen(r)) {
    confirmDialog('Отправить сейчас',
      `Отправить в группу кухни список на приготовление по сегодняшним подтверждённым заказам? ` +
      'На расписание это не влияет.',
      async () => {
        const res = await api.post(`/api/admin/reminders/${r.id}/test`);
        toast(`Отправлено на кухню — заказов: ${res.orders}`);
      },
      'Отправить');
    return;
  }

  const count = audienceCount(r.audience);
  confirmDialog('Отправить сейчас',
    `Отправить «${r.name}» прямо сейчас? Получат ${count} чел. ` +
    'На расписание это не влияет — сегодняшняя отправка всё равно произойдёт.',
    async () => {
      const res = await api.post(`/api/admin/reminders/${r.id}/test`);
      toast(`Отправляется — получателей: ${res.recipients}`);
    },
    'Отправить');
}

/* ── form ────────────────────────────────────────────────────── */

function openForm(reminder) {
  const isNew = !reminder;
  const a = reminder?.audience || { mode: 'all', company_ids: [], user_ids: [] };

  /* Held outside the markup because the day buttons, the audience mode and
     the recipient count all change without the dialog being rebuilt. */
  const draft = {
    days: new Set((reminder?.days || [1, 2, 3, 4, 5]).map(Number)),
    mode: a.mode || 'all',
    company_ids: [...(a.company_ids || [])],
    user_ids: [...(a.user_ids || [])]
  };

  modal({
    title: isNew ? 'Новое уведомление' : `Изменить: ${reminder.name}`,
    submitLabel: isNew ? 'Создать' : 'Сохранить',
    wide: true,
    bodyHTML: `
      <div class="field">
        <label class="field__label" for="rf-name">Название</label>
        <input class="input" id="rf-name" name="name" maxlength="80" required
               placeholder="Ежедневное уведомление о заказе"
               value="${esc(reminder?.name || '')}">
        <p class="hint">Видно только здесь — пользователям уходит текст ниже.</p>
      </div>

      <div class="field">
        <span class="field__label">Дни недели</span>
        <div class="daypick" id="rf-days">
          ${WEEK.map(([n, short, full]) => `
            <button type="button" data-day="${n}" title="${full}"
                    aria-pressed="${draft.days.has(n)}">${short}</button>`).join('')}
        </div>
        <p class="picker__tools" style="margin-top:8px">
          ${PRESETS.map(([label], i) =>
            `<button type="button" class="linkbtn" data-preset="${i}">${label}</button>`)
            .join(' · ')}
        </p>
      </div>

      <div class="field">
        <label class="field__label" for="rf-time">Время</label>
        <input class="input input--sm" id="rf-time" name="time_of_day" type="time"
               required value="${esc(reminder?.time_of_day || '16:00')}">
        <p class="hint">Местное время. Расписание проверяется каждые ${TICK_MIN} минут,
           поэтому сообщение уйдёт в течение ${TICK_MIN} минут после указанного времени.</p>
      </div>

      <div class="field" id="rf-text-field">
        <label class="field__label" for="rf-text">Текст сообщения</label>
        <textarea class="input" id="rf-text" name="text" rows="4" required
                  maxlength="${MAX_TEXT}"
                  placeholder="Не забудьте оформить заказ до 20:00">${esc(reminder?.text || '')}</textarea>
        <p class="hint"><span id="rf-count">0</span> / ${MAX_TEXT} символов.
           Отправляется обычным текстом — разметка не поддерживается.</p>
      </div>

      <div class="field">
        <span class="field__label">Кому</span>
        <div class="seg" id="rf-mode">
          <button type="button" data-v="all"       aria-pressed="${draft.mode === 'all'}">Всем</button>
          <button type="button" data-v="companies" aria-pressed="${draft.mode === 'companies'}">Компаниям</button>
          <button type="button" data-v="users"     aria-pressed="${draft.mode === 'users'}">Отдельным людям</button>
          <button type="button" data-v="kitchen"   aria-pressed="${draft.mode === 'kitchen'}">Кухне</button>
        </div>
        <p class="hint" id="rf-count-people">—</p>
      </div>

      <div id="rf-picker"></div>

      <div class="field" style="margin-bottom:0">
        <label class="switch">
          <span style="font-weight:700">Включено</span>
          <input type="checkbox" name="enabled" ${reminder?.enabled !== false ? 'checked' : ''}>
          <span class="switch__track"></span>
        </label>
        <p class="hint">Выключенное уведомление остаётся здесь, но не отправляется.</p>
      </div>`,

    onSubmit: async (data) => {
      // The day buttons are not form fields, so this is the one rule the
      // browser cannot enforce on its own.
      if (!draft.days.size) {
        toast('Выберите хотя бы один день недели', 'err');
        return false;
      }
      const payload = {
        name: data.name,
        days: [...draft.days].sort((x, y) => x - y),
        time_of_day: data.time_of_day,
        text: draft.mode === 'kitchen' ? '' : data.text,
        enabled: data.enabled === 'on',
        audience: {
          mode: draft.mode,
          company_ids: draft.mode === 'companies' ? draft.company_ids : [],
          user_ids: draft.mode === 'users' ? draft.user_ids : []
        }
      };
      if (isNew) {
        await api.post('/api/admin/reminders', payload);
        toast('Уведомление создано');
      } else {
        await api.patch(`/api/admin/reminders/${reminder.id}`, payload);
        toast('Изменения сохранены');
      }
      await load(true);
    }
  });

  wireForm(draft);
}

function wireForm(draft) {
  // the dialog just opened, so it is the last one on the page
  const box = [...document.querySelectorAll('.modal__body')].pop();
  if (!box) return;

  const daysBar = box.querySelector('#rf-days');
  const paintDays = () => {
    daysBar.querySelectorAll('[data-day]').forEach((b) => {
      b.setAttribute('aria-pressed', draft.days.has(Number(b.dataset.day)));
    });
  };
  daysBar.querySelectorAll('[data-day]').forEach((b) => {
    b.onclick = () => {
      const d = Number(b.dataset.day);
      if (draft.days.has(d)) draft.days.delete(d); else draft.days.add(d);
      paintDays();
    };
  });
  box.querySelectorAll('[data-preset]').forEach((b) => {
    b.onclick = () => {
      draft.days = new Set(PRESETS[Number(b.dataset.preset)][1]);
      paintDays();
    };
  });

  const text = box.querySelector('#rf-text');
  const count = box.querySelector('#rf-count');
  const paintCount = () => {
    count.textContent = text.value.length;
    count.style.color = text.value.length >= MAX_TEXT ? 'var(--danger)' : '';
  };
  text.oninput = paintCount;
  paintCount();

  // a kitchen reminder sends the prep list, not a text
  const textField = box.querySelector('#rf-text-field');
  const paintText = () => {
    const kitchen = draft.mode === 'kitchen';
    textField.style.display = kitchen ? 'none' : '';
    text.required = !kitchen;
  };

  const people = box.querySelector('#rf-count-people');
  const paintPeople = () => {
    if (draft.mode === 'kitchen') {
      people.textContent = 'В группу кухни уйдёт список на приготовление '
        + 'по подтверждённым заказам на сегодня. Если заказов нет, ничего не отправится.';
      return;
    }
    const n = audienceCount({
      mode: draft.mode, company_ids: draft.company_ids, user_ids: draft.user_ids
    });
    people.textContent = `Получат ${n} чел. Только пользователи с открытым доступом, `
      + 'которые запускали бота.';
  };

  const slot = box.querySelector('#rf-picker');
  const drawPicker = () => {
    if (draft.mode === 'all' || draft.mode === 'kitchen') { slot.innerHTML = ''; paintPeople(); return; }

    const isCompanies = draft.mode === 'companies';
    const options = isCompanies
      ? companies.map((c) => ({
          id: c.id,
          label: c.company_name || `#${c.id}`,
          note: `${reachable().filter((u) => u.company_id === c.id).length} чел.`
        }))
      : reachable().map((u) => ({
          id: u.id,
          label: u.user_name || `#${u.id}`,
          note: u.companies?.company_name || '—'
        }));
    const chosen = isCompanies ? draft.company_ids : draft.user_ids;

    if (!options.length) {
      slot.innerHTML = `<div class="field"><p class="hint">Некому отправлять — нет подходящих записей.</p></div>`;
      paintPeople();
      return;
    }

    slot.innerHTML = `
      <div class="field">
        <p class="picker__tools">
          <button type="button" class="linkbtn" data-all>Выбрать все</button> ·
          <button type="button" class="linkbtn" data-none>Снять выбор</button>
        </p>
        <div class="picker" id="rf-list">
          ${options.map((o) => `
            <label class="picker__row">
              <input type="checkbox" value="${o.id}" ${chosen.includes(o.id) ? 'checked' : ''}>
              <span class="picker__label">${esc(o.label)}</span>
              <span class="picker__note">${esc(o.note)}</span>
            </label>`).join('')}
        </div>
      </div>`;

    const list = slot.querySelector('#rf-list');
    const read = () => {
      const ids = [...list.querySelectorAll('input:checked')].map((i) => Number(i.value));
      if (isCompanies) draft.company_ids = ids; else draft.user_ids = ids;
      paintPeople();
    };
    list.onchange = read;
    slot.querySelector('[data-all]').onclick = () => {
      list.querySelectorAll('input').forEach((i) => { i.checked = true; });
      read();
    };
    slot.querySelector('[data-none]').onclick = () => {
      list.querySelectorAll('input').forEach((i) => { i.checked = false; });
      read();
    };
    paintPeople();
  };

  box.querySelectorAll('#rf-mode button').forEach((b) => {
    b.onclick = () => {
      draft.mode = b.dataset.v;
      box.querySelectorAll('#rf-mode button').forEach((x) => {
        x.setAttribute('aria-pressed', x.dataset.v === draft.mode);
      });
      paintText();
      drawPicker();
    };
  });

  paintText();
  drawPicker();
}
