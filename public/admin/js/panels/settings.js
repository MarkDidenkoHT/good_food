import { api } from '../api.js';
import { h, esc, toast, paintSegs } from '../ui.js';
import { paintIcons } from '../icons.js';

/* Grouping the catalog by category only works if every item has one, so that
   save is allowed to fail with the list of offenders and we render it inline.

   Order rules live in two cards on purpose: «Изменение заказов» is about what
   a customer may do to their own order, «Ограничение по времени» about the
   daily deadline. Either works without the other. */

let settings = {
  catalog: { group_by_category: false, show_images: false },
  notifications: { notify_owner: true },
  orders: {
    allow_edit_confirmed: false, allow_delete_new: false,
    returns_from_history: false,
    cutoff_enabled: false, cutoff_time: '22:00', lock_after_cutoff: true,
    after_cutoff: 'next_day', resume_time: '08:00'
  },
  frontpad: { enabled: false, mode: 'on_confirm', batch_time: '18:00' }
};
let orphans = [];
let root;

/* What the last draw put on screen, so the next one can tell which fields are
   genuinely new and animate only those. A redraw that changes nothing
   structural must not make the whole panel move. */
let shown = { cutoff: null, blocking: null, fp: null, fpBatch: null };

export const settingsPanel = {
  id: 'settings',
  label: 'Настройки',
  icon: 'settings',
  title: 'Настройки',
  subtitle: 'Общие настройки приложения',

  actions: () => [
    h(`<button class="btn btn--ghost btn--icon" id="set-refresh" title="Обновить"><span data-icon="refresh"></span></button>`)
  ],

  preload: () => ['/api/admin/settings'],

  async render(container) {
    root = container;
    root.append(h(`<div id="settings-body"></div>`));
    document.getElementById('set-refresh')?.addEventListener('click', () => load(true));
    await load();
  }

};

/* h() returns one element; this screen renders several sibling cards. */
function frag(html) {
  const t = document.createElement('div');
  t.innerHTML = html.trim();
  return t;
}

async function load(fresh = false) {
  try {
    settings = await api.get('/api/admin/settings', { fresh });
    orphans = [];
    draw();
  } catch (e) {
    toast(e.message, 'err');
  }
}

function draw() {
  const body = root?.querySelector('#settings-body');
  if (!body) return;
  const grouped = !!settings.catalog?.group_by_category;
  const notifyOwner = settings.notifications?.notify_owner !== false;
  const images = !!settings.catalog?.show_images;
  const imgSize = settings.catalog?.image_size || 'md';
  const o = settings.orders || {};
  const cutoffOn = !!o.cutoff_enabled;
  const lockAfter = o.lock_after_cutoff !== false;
  const blocking = o.after_cutoff === 'block';
  const allowDelete = !!o.allow_delete_new;
  const editConfirmed = !!o.allow_edit_confirmed;
  const fromHistory = !!o.returns_from_history;
  const fp = settings.frontpad || {};
  const fpOn = !!fp.enabled;
  const fpBatch = fp.mode === 'batch';

  body.innerHTML = '';
  const card = frag(`
    <div class="card">
      <div class="card__head"><div class="card__title">Каталог в приложении</div></div>
      <div class="card__body">
        <div class="field" style="margin-bottom:0">
          <span class="field__label">Отображение позиций</span>
          <div class="seg" id="seg-catalog">
            <button data-v="list"     aria-pressed="${!grouped}">Списком</button>
            <button data-v="grouped"  aria-pressed="${grouped}">По категориям</button>
          </div>
          <p class="hint">Как пользователи увидят каталог в мини-приложении.</p>
        </div>

        <div class="field" style="margin:16px 0 0">
          <span class="field__label">Изображения</span>
          <div class="seg" id="seg-images">
            <button data-v="off" aria-pressed="${!images}">Без картинок</button>
            <button data-v="on"  aria-pressed="${images}">Показывать</button>
          </div>
          <p class="hint">Картинки категорий и позиций в мини-приложении.
             Загружаются на вкладке «Позиции».</p>
        </div>

        <div class="field" style="margin:16px 0 0" ${images ? '' : 'hidden'}>
          <span class="field__label">Размер изображений</span>
          <div class="seg" id="seg-img-size">
            <button data-v="sm" aria-pressed="${imgSize === 'sm'}">Маленькие</button>
            <button data-v="md" aria-pressed="${imgSize === 'md'}">Средние</button>
            <button data-v="lg" aria-pressed="${imgSize === 'lg'}">Большие</button>
          </div>
          <p class="hint">Насколько крупно позиции показаны в списке: 40, 60 или 80&nbsp;пикселей.</p>
        </div>
        <div id="settings-error"></div>
      </div>
    </div>

    <div class="card" style="margin-top:16px">
      <div class="card__head"><div class="card__title">Уведомления о заказах</div></div>
      <div class="card__body">
        <div class="field" style="margin-bottom:0">
          <span class="field__label">Кого уведомлять при подтверждении</span>
          <div class="seg" id="seg-notify">
            <button data-v="author" aria-pressed="${!notifyOwner}">Только заказчика</button>
            <button data-v="both"   aria-pressed="${notifyOwner}">Заказчика и владельца</button>
          </div>
          <p class="hint">Владелец компании — сотрудник с ролью «Владелец».
             Если заказ сделал он сам, сообщение придёт один раз.</p>
        </div>
      </div>
    </div>

    <div class="card" style="margin-top:16px">
      <div class="card__head"><div class="card__title">Изменение заказов</div></div>
      <div class="card__body">
        <div class="field">
          <span class="field__label">Изменение подтверждённых заказов</span>
          <div class="seg" id="seg-edit-confirmed">
            <button data-v="off" aria-pressed="${!editConfirmed}">Запрещено</button>
            <button data-v="on"  aria-pressed="${editConfirmed}">Разрешено</button>
          </div>
          <p class="hint">Неподтверждённый заказ заказчик меняет всегда.
             «Разрешено» — он может править состав и после того, как заказ
             приняли${cutoffOn && lockAfter ? ', но не позже времени закрытия' : ''}.</p>
        </div>

        <div class="field">
          <span class="field__label">Отмена неподтверждённых заказов</span>
          <div class="seg" id="seg-delete">
            <button data-v="off" aria-pressed="${!allowDelete}">Запрещена</button>
            <button data-v="on"  aria-pressed="${allowDelete}">Разрешена</button>
          </div>
          <p class="hint">Разрешает заказчику удалить свой заказ, пока его не
             подтвердили.</p>
        </div>

        <div class="field" style="margin-bottom:0">
          <span class="field__label">Оформление возврата</span>
          <div class="seg" id="seg-returns">
            <button data-v="free"    aria-pressed="${!fromHistory}">Из каталога</button>
            <button data-v="history" aria-pressed="${fromHistory}">Только из истории заказов</button>
          </div>
          <p class="hint">${fromHistory
            ? 'Вкладки «Возврат» в приложении нет. Заказчик открывает нужный заказ в истории и отмечает, что возвращает — не больше, чем было заказано.'
            : 'Заказчик собирает возврат из каталога, как обычный заказ.'}</p>
        </div>
      </div>
    </div>

    <div class="card" style="margin-top:16px">
      <div class="card__head"><div class="card__title">Ограничение по времени</div></div>
      <div class="card__body">
        <div class="field" ${cutoffOn ? '' : 'style="margin-bottom:0"'}>
          <span class="field__label">Ограничение</span>
          <div class="seg" id="seg-cutoff">
            <button data-v="off" aria-pressed="${!cutoffOn}">Выключено</button>
            <button data-v="on"  aria-pressed="${cutoffOn}">Включено</button>
          </div>
          <p class="hint">Одно время в сутки, после которого день считается
             закрытым. Пока ограничение выключено, время работы приёма ничем
             не ограничено.</p>
        </div>

        ${cutoffOn ? `
        <div class="field">
          <label class="field__label" for="cutoff-time">Время закрытия</label>
          <input id="cutoff-time" type="time" value="${esc(o.cutoff_time || '22:00')}">
          <p class="hint">Местное время, по которому проходит граница дня.</p>
        </div>

        <div class="field">
          <span class="field__label">Изменение заказов после этого времени</span>
          <div class="seg" id="seg-lock">
            <button data-v="off" aria-pressed="${!lockAfter}">Оставить доступным</button>
            <button data-v="on"  aria-pressed="${lockAfter}">Запретить полностью</button>
          </div>
          <p class="hint">«Запретить полностью» — после времени закрытия заказы
             дня уходят в работу: ни изменить, ни отменить их уже нельзя,
             независимо от настроек выше.</p>
        </div>

        <div class="field" ${blocking ? '' : 'style="margin-bottom:0"'}>
          <label class="field__label" for="sel-after">Новые заказы после этого времени</label>
          <select class="select" id="sel-after">
            <option value="next_day" ${!blocking ? 'selected' : ''}>Оформлять на следующий день</option>
            <option value="block"    ${blocking ? 'selected' : ''}>Не принимать до следующего дня</option>
          </select>
          <p class="hint">${blocking
            ? 'Приём закрыт до указанного ниже времени — заказчик увидит, когда откроется снова.'
            : 'Заказ проходит как обычно, но автоматически попадает в список на завтра.'}</p>
        </div>

        ${blocking ? `
        <div class="field" style="margin-bottom:0">
          <label class="field__label" for="resume-time">Приём открывается снова в</label>
          <input id="resume-time" type="time" value="${esc(o.resume_time || '08:00')}">
          <p class="hint">Утром следующего дня.</p>
        </div>` : ''}` : ''}
      </div>
    </div>

    <div class="card" style="margin-top:16px">
      <div class="card__head"><div class="card__title">FrontPad</div></div>
      <div class="card__body">
        <div class="alert" style="margin:0 0 16px">
          <div class="alert__title">Пока это заготовка</div>
          <p>Настройка сохраняется, но заказы в FrontPad <b>ещё не отправляются</b>.
             Вместо отправки в журнал сервера пишется, что именно ушло&nbsp;бы —
             так видно, что всё сходится, до первой реальной отправки.
             Артикул каждой позиции задаётся на вкладке «Позиции».</p>
        </div>

        <div class="field" ${fpOn ? '' : 'style="margin-bottom:0"'}>
          <span class="field__label">Передача заказов</span>
          <div class="seg" id="seg-fp">
            <button data-v="off" aria-pressed="${!fpOn}">Выключена</button>
            <button data-v="on"  aria-pressed="${fpOn}">Включена</button>
          </div>
          <p class="hint">Возвраты не передаются никогда — в FrontPad для них
             нет соответствия.</p>
        </div>

        ${fpOn ? `
        <div class="field" ${fpBatch ? '' : 'style="margin-bottom:0"'}>
          <span class="field__label">Когда передавать</span>
          <div class="seg" id="seg-fp-mode">
            <button data-v="on_confirm" aria-pressed="${!fpBatch}">При подтверждении</button>
            <button data-v="batch"      aria-pressed="${fpBatch}">Все за день, разом</button>
          </div>
          <p class="hint">${fpBatch
            ? 'Подтверждённые за день заказы уходят одной пачкой в указанное время.'
            : 'Каждый заказ уходит сразу, как только его подтвердили в панели.'}</p>
        </div>

        ${fpBatch ? `
        <div class="field" style="margin-bottom:0">
          <label class="field__label" for="fp-time">Время передачи</label>
          <input id="fp-time" type="time" value="${esc(fp.batch_time || '18:00')}">
          <p class="hint">Местное время. Заказы, подтверждённые после него,
             уйдут на следующий день.</p>
        </div>` : ''}` : ''}
      </div>
    </div>`);

  card.querySelectorAll('#seg-cutoff button').forEach((b) => {
    b.onclick = () => saveOrders({ cutoff_enabled: b.dataset.v === 'on' });
  });
  card.querySelectorAll('#seg-lock button').forEach((b) => {
    b.onclick = () => saveOrders({ lock_after_cutoff: b.dataset.v === 'on' });
  });
  card.querySelectorAll('#seg-delete button').forEach((b) => {
    b.onclick = () => saveOrders({ allow_delete_new: b.dataset.v === 'on' });
  });
  card.querySelectorAll('#seg-returns button').forEach((b) => {
    b.onclick = () => saveOrders({ returns_from_history: b.dataset.v === 'history' });
  });
  card.querySelectorAll('#seg-edit-confirmed button').forEach((b) => {
    b.onclick = () => saveOrders({ allow_edit_confirmed: b.dataset.v === 'on' });
  });

  const after = card.querySelector('#sel-after');
  if (after) after.onchange = () => saveOrders({ after_cutoff: after.value });

  // one save per finished edit, not per keystroke
  const cutoff = card.querySelector('#cutoff-time');
  if (cutoff) cutoff.onchange = () => saveOrders({ cutoff_time: cutoff.value });
  const resume = card.querySelector('#resume-time');
  if (resume) resume.onchange = () => saveOrders({ resume_time: resume.value });

  card.querySelectorAll('#seg-catalog button').forEach((b) => {
    b.onclick = () => save(b.dataset.v === 'grouped');
  });

  card.querySelectorAll('#seg-images button').forEach((b) => {
    b.onclick = () => saveCatalog({ show_images: b.dataset.v === 'on' });
  });

  card.querySelectorAll('#seg-img-size button').forEach((b) => {
    b.onclick = () => saveCatalog({ image_size: b.dataset.v });
  });

  card.querySelectorAll('#seg-notify button').forEach((b) => {
    b.onclick = () => saveNotify(b.dataset.v === 'both');
  });

  card.querySelectorAll('#seg-fp button').forEach((b) => {
    b.onclick = () => saveFrontpad({ enabled: b.dataset.v === 'on' });
  });
  card.querySelectorAll('#seg-fp-mode button').forEach((b) => {
    b.onclick = () => saveFrontpad({ mode: b.dataset.v });
  });
  const fpTime = card.querySelector('#fp-time');
  if (fpTime) fpTime.onchange = () => saveFrontpad({ batch_time: fpTime.value });

  body.append(card);
  if (orphans.length) body.querySelector('#settings-error').append(orphanBox());

  // Only the fields that were not there a moment ago slide in.
  if (cutoffOn && shown.cutoff === false) markEntering(body, '#cutoff-time, #seg-lock, #sel-after');
  if (blocking && shown.blocking === false) markEntering(body, '#resume-time');
  if (fpOn && shown.fp === false) markEntering(body, '#seg-fp-mode');
  if (fpBatch && shown.fpBatch === false) markEntering(body, '#fp-time');
  shown = { cutoff: cutoffOn, blocking, fp: fpOn, fpBatch };

  paintIcons(body);
  paintSegs(body);
}

function markEntering(body, selector) {
  body.querySelectorAll(selector).forEach((el) => el.closest('.field')?.classList.add('field--enter'));
}

function orphanBox() {
  return h(`
    <div class="alert alert--err" style="margin-top:16px">
      <div class="alert__title">Нельзя включить показ по категориям</div>
      <p>У этих позиций не указана категория. Назначьте категорию каждой из них
         на вкладке «Позиции», затем включите настройку снова.</p>
      <ul class="alert__list">
        ${orphans.map((o) => `<li>Назначьте категорию позиции «${esc(o.item_name || `#${o.id}`)}»</li>`).join('')}
      </ul>
    </div>`);
}

async function save(grouped) {
  const before = settings.catalog;
  settings.catalog = { ...settings.catalog, group_by_category: grouped };
  orphans = [];
  draw();
  try {
    const res = await api.put('/api/admin/settings/catalog', { group_by_category: grouped });
    settle('catalog', res.value);
    toast('Настройка сохранена');
  } catch (e) {
    settings.catalog = before;
    draw();
    // the 409 carries the offending items — api.js only surfaces the message,
    // so re-fetch them for the inline list
    if (/категори/i.test(e.message)) {
      try {
        const items = await api.get('/api/admin/items');
        orphans = items.filter((i) => !i.item_category).map((i) => ({ id: i.id, item_name: i.item_name }));
      } catch { orphans = []; }
      draw();
      toast(e.message, 'err');
      return;
    }
    toast(e.message, 'err');
  }
}

async function saveNotify(notifyOwner) {
  const before = settings.notifications;
  settings.notifications = { ...settings.notifications, notify_owner: notifyOwner };
  draw();
  try {
    const res = await api.put('/api/admin/settings/notifications', { notify_owner: notifyOwner });
    settle('notifications', res.value);
    toast('Настройка сохранена');
  } catch (e) {
    settings.notifications = before;
    draw();
    toast(e.message, 'err');
  }
}

/* Both image controls write the same row, one key at a time. */
async function saveCatalog(patch) {
  const before = settings.catalog;
  settings.catalog = { ...settings.catalog, ...patch };
  draw();
  try {
    const res = await api.put('/api/admin/settings/catalog', patch);
    settle('catalog', res.value);
    toast('Настройка сохранена');
  } catch (e) {
    settings.catalog = before;
    draw();
    toast(e.message, 'err');
  }
}

async function saveFrontpad(patch) {
  const before = settings.frontpad;
  settings.frontpad = { ...settings.frontpad, ...patch };
  draw();
  try {
    const res = await api.put('/api/admin/settings/frontpad', patch);
    settle('frontpad', res.value);
    toast('Настройка сохранена');
  } catch (e) {
    settings.frontpad = before;
    draw();
    toast(e.message, 'err');
  }
}

async function saveOrders(patch) {
  const before = settings.orders;
  settings.orders = { ...settings.orders, ...patch };
  draw();
  try {
    const res = await api.put('/api/admin/settings/orders', patch);
    settle('orders', res.value);
    toast('Настройка сохранена');
  } catch (e) {
    settings.orders = before;     // put the rejected value back to what is stored
    draw();
    toast(e.message, 'err');
  }
}

/* The server's answer is the authority, but it is almost always exactly what
   was already drawn — so take the value and redraw only when it actually
   differs. Redrawing regardless is what made saving a setting flash half a
   second after the press.

   Compared by key, not by JSON text: the server builds its answer by merging
   defaults with the stored row, so the same settings can arrive with the keys
   in a different order, and a plain stringify would call every save a change
   and redraw every time — which is the flash this is here to prevent. */
function settle(key, value) {
  const changed = !sameShallow(settings[key], value);
  settings[key] = value;
  if (changed) draw();
}

function sameShallow(a = {}, b = {}) {
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  for (const k of keys) if (a?.[k] !== b?.[k]) return false;
  return true;
}
