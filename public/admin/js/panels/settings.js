import { api } from '../api.js';
import { h, esc, toast, paintSegs, confirmDialog } from '../ui.js';
import { paintIcons } from '../icons.js';

/* Grouping the catalog by category only works if every item has one, so that
   save is allowed to fail with the list of offenders and we render it inline.

   Order rules live in two cards on purpose: «Изменение заказов» is about what
   a customer may do to their own order, «Ограничение по времени» about the
   daily deadline. Either works without the other. */

let settings = {
  catalog: { group_by_category: false, show_images: false },
  notifications: { notify_owner: true },
  auth: { allow_owner_reset: false },
  design: { background_path: null },
  server: { public_url: '' },
  contact: { manager_username: 'lovesushitrifle' },
  materials: { use_cost: true },
  orders: {
    allow_edit_confirmed: false, allow_delete_new: false,
    cutoff_enabled: false, cutoff_time: '22:00', lock_after_cutoff: true,
    after_cutoff: 'next_day', resume_time: '08:00'
  },
  frontpad: { enabled: false, simulation: true, verbose: true, delivery_time: '10:00' }
};
let orphans = [];
let root;
let fpLog = null;          // { configured, rows } — loaded lazily with the card
let fpTest = null;         // last «Проверить связь» answer
let backups = null;        // loaded lazily with the card, newest first

/* What the last draw put on screen, so the next one can tell which fields are
   genuinely new and animate only those. A redraw that changes nothing
   structural must not make the whole panel move. */
let shown = { cutoff: null, blocking: null, fp: null };

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
    loadFpLog();
    loadBackups();
  } catch (e) {
    toast(e.message, 'err');
  }
}

function draw() {
  const body = root?.querySelector('#settings-body');
  if (!body) return;
  const grouped = !!settings.catalog?.group_by_category;
  const notifyOwner = settings.notifications?.notify_owner !== false;
  const ownerReset = !!settings.auth?.allow_owner_reset;
  const images = !!settings.catalog?.show_images;
  const imgSize = settings.catalog?.image_size || 'md';
  const bgPath = settings.design?.background_path || null;
  const o = settings.orders || {};
  const cutoffOn = !!o.cutoff_enabled;
  const lockAfter = o.lock_after_cutoff !== false;
  const blocking = o.after_cutoff === 'block';
  const allowDelete = !!o.allow_delete_new;
  const editConfirmed = !!o.allow_edit_confirmed;
  const fp = settings.frontpad || {};
  const fpOn = !!fp.enabled;
  const fpSim = fp.simulation !== false;
  const fpVerbose = fp.verbose !== false;
  const publicUrl = settings.server?.public_url || '';
  const manager = settings.contact?.manager_username || '';
  const useCost = settings.materials?.use_cost !== false;

  body.innerHTML = '';
  const card = frag(`
    <div class="card">
      <div class="card__head"><div class="card__title">Адрес сервера</div></div>
      <div class="card__body">
        <div class="field" style="margin-bottom:0">
          <label class="field__label" for="public-url">Публичный адрес</label>
          <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
            <input id="public-url" class="input" type="url" placeholder="https://food.example.com"
                   value="${esc(publicUrl)}" style="flex:1 1 260px;min-width:0">
            <button class="btn btn--sm" id="public-url-save">Сохранить</button>
          </div>
          <p class="hint">Адрес, по которому сервер открывается из интернета, только https.
             При сохранении бот Telegram переключается на этот адрес. По нему же
             открываются кнопки «Открыть в админ-панели» в группе операторов.</p>
        </div>
      </div>
    </div>

    <div class="card" style="margin-top:16px">
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
      <div class="card__head"><div class="card__title">Оформление</div></div>
      <div class="card__body">
        <div class="field" style="margin-bottom:0">
          <span class="field__label">Фон приложения</span>
          <div class="imgpick imgpick--lg">
            <div class="imgpick__preview">
              ${bgPath ? `<img src="/api/admin/images/view?path=${encodeURIComponent(bgPath)}" alt="">` : '<span>нет</span>'}
            </div>
            <div class="imgpick__actions">
              <input type="file" id="bg-file" accept="image/jpeg,image/png,image/webp,image/gif" hidden>
              <button type="button" class="btn btn--sm" id="bg-choose">Загрузить</button>
              <button type="button" class="btn btn--sm" id="bg-clear" ${bgPath ? '' : 'disabled'}>Убрать</button>
              <p class="hint" id="bg-hint">Новинка или акция за каталогом в мини-приложении.
                 JPEG, PNG, WebP или GIF, до 5 МБ. Лучше вертикальная картинка.</p>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="card" style="margin-top:16px">
      <div class="card__head"><div class="card__title">Связь с менеджером</div></div>
      <div class="card__body">
        <div class="field" style="margin-bottom:0">
          <label class="field__label" for="manager-username">Telegram менеджера</label>
          <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
            <input id="manager-username" class="input" placeholder="lovesushitrifle"
                   value="${esc(manager)}" style="flex:1 1 260px;min-width:0">
            <button class="btn btn--sm" id="manager-save">Сохранить</button>
          </div>
          <p class="hint">Кнопка «Связаться с менеджером» в мини-приложении открывает чат
             с этим аккаунтом. Подойдёт имя, @имя или ссылка t.me. Пусто — кнопки нет.</p>
        </div>
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
      <div class="card__head"><div class="card__title">Себестоимость сырья</div></div>
      <div class="card__body">
        <div class="field" style="margin-bottom:0">
          <span class="field__label">Стоимость сырья</span>
          <div class="seg" id="seg-material-cost">
            <button data-v="on"  aria-pressed="${useCost}">Учитывать</button>
            <button data-v="off" aria-pressed="${!useCost}">Не учитывать</button>
          </div>
          <p class="hint">${useCost
            ? 'У сырья указывается стоимость, а себестоимость видна в позициях, в списке для кухни и в выгрузке сырья.'
            : 'Стоимость сырья не вводится и нигде не показывается. Уже введённые цены сохраняются.'}</p>
        </div>
      </div>
    </div>

    <div class="card" style="margin-top:16px">
      <div class="card__head"><div class="card__title">Пароль компании</div></div>
      <div class="card__body">
        <div class="field" style="margin-bottom:0">
          <span class="field__label">Кто может перевыпустить пароль</span>
          <div class="seg" id="seg-owner-reset">
            <button data-v="off" aria-pressed="${!ownerReset}">Только администратор</button>
            <button data-v="on"  aria-pressed="${ownerReset}">Администратор и владелец компании</button>
          </div>
          <p class="hint">Перевыпуск сразу отключает от приложения всех
             сотрудников компании: вернётся только тот, кому передали новый
             пароль. ${ownerReset
               ? 'Владелец может сделать это сам из приложения — новый пароль придёт ему и в группу операторов.'
               : 'Владельцу придётся обратиться к администратору.'}</p>
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

        <div class="field" style="margin-bottom:0">
          <span class="field__label">Отмена неподтверждённых заказов</span>
          <div class="seg" id="seg-delete">
            <button data-v="off" aria-pressed="${!allowDelete}">Запрещена</button>
            <button data-v="on"  aria-pressed="${allowDelete}">Разрешена</button>
          </div>
          <p class="hint">Разрешает заказчику удалить свой заказ, пока его не
             подтвердили.</p>
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
        ${fpOn && fpSim ? `
        <div class="alert" style="margin:0 0 16px">
          <div class="alert__title">Режим симуляции</div>
          <p>Заказ собирается полностью (артикулы, дата, телефон) и пишется в
             журнал ниже, но <b>в FrontPad ничего не уходит</b>. Когда в журнале
             всё сходится — переключите на «Боевой».</p>
        </div>` : ''}
        ${fpOn && !fpSim ? `
        <div class="alert alert--err" style="margin:0 0 16px">
          <div class="alert__title">Боевой режим</div>
          <p>Каждый подтверждённый заказ создаётся в FrontPad. Если FrontPad
             откажет — заказ не подтвердится, и вы увидите причину.</p>
        </div>` : ''}

        <div class="field" ${fpOn ? '' : 'style="margin-bottom:0"'}>
          <span class="field__label">Передача заказов</span>
          <div class="seg" id="seg-fp">
            <button data-v="off" aria-pressed="${!fpOn}">Выключена</button>
            <button data-v="on"  aria-pressed="${fpOn}">Включена</button>
          </div>
          <p class="hint">Заказ уходит в FrontPad в момент, когда его
             подтверждают в панели. Артикул каждой позиции задаётся на вкладке «Позиции».</p>
        </div>

        ${fpOn ? `
        <div class="field">
          <span class="field__label">Режим</span>
          <div class="seg" id="seg-fp-sim">
            <button data-v="on"  aria-pressed="${fpSim}">Симуляция</button>
            <button data-v="off" aria-pressed="${!fpSim}">Боевой</button>
          </div>
        </div>

        <div class="field">
          <label class="field__label" for="fp-deliv">Время доставки в FrontPad</label>
          <input id="fp-deliv" type="time" value="${esc(fp.delivery_time || '10:00')}">
          <p class="hint">Дата доставки — следующий день после дня заказа, в это время.</p>
        </div>

        <div class="field">
          <span class="field__label">Подробные логи сервера</span>
          <div class="seg" id="seg-fp-verbose">
            <button data-v="on"  aria-pressed="${fpVerbose}">Включены</button>
            <button data-v="off" aria-pressed="${!fpVerbose}">Кратко</button>
          </div>
          <p class="hint">Карта артикулов и каждая строка заказа в логах сервера.
             Журнал ниже ведётся в любом случае.</p>
        </div>` : ''}

        <div class="field" style="margin-bottom:0">
          <span class="field__label">Связь с FrontPad</span>
          <button class="btn btn--sm" id="fp-test">Проверить связь</button>
          <div id="fp-test-out">${fpTestHTML()}</div>
        </div>
      </div>
    </div>

    <div class="card" style="margin-top:16px">
      <div class="card__head">
        <div class="card__title">Журнал FrontPad</div>
        <div style="flex:1 1 auto"></div>
        <button class="btn btn--ghost btn--sm" id="fp-log-refresh">Обновить</button>
      </div>
      <div id="fp-log">${fpLogHTML()}</div>
    </div>

    <div class="card" style="margin-top:16px">
      <div class="card__head">
        <div class="card__title">Резервные копии</div>
        <div style="flex:1 1 auto"></div>
        <button class="btn btn--sm" id="bk-create">Создать копию</button>
      </div>
      <div class="card__body" style="padding-bottom:0">
        <p class="hint" style="margin:0">Каждый день в 03:00 сохраняются все данные и картинки.
           Копии хранятся 30 дней.</p>
      </div>
      <div id="bk-list">${backupsHTML()}</div>
    </div>`);

  const urlInput = card.querySelector('#public-url');
  card.querySelector('#public-url-save').onclick = () => saveServer(urlInput.value);
  urlInput.onkeydown = (e) => { if (e.key === 'Enter') saveServer(urlInput.value); };

  const managerInput = card.querySelector('#manager-username');
  card.querySelector('#manager-save').onclick = () => saveContact(managerInput.value);
  managerInput.onkeydown = (e) => { if (e.key === 'Enter') saveContact(managerInput.value); };

  card.querySelectorAll('#seg-cutoff button').forEach((b) => {
    b.onclick = () => saveOrders({ cutoff_enabled: b.dataset.v === 'on' });
  });
  card.querySelectorAll('#seg-lock button').forEach((b) => {
    b.onclick = () => saveOrders({ lock_after_cutoff: b.dataset.v === 'on' });
  });
  card.querySelectorAll('#seg-delete button').forEach((b) => {
    b.onclick = () => saveOrders({ allow_delete_new: b.dataset.v === 'on' });
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

  const bgFile = card.querySelector('#bg-file');
  card.querySelector('#bg-choose').onclick = () => bgFile.click();
  bgFile.onchange = () => uploadBackground(bgFile.files?.[0]);
  card.querySelector('#bg-clear').onclick = () =>
    confirmDialog('Убрать фон', 'Фон исчезнет из мини-приложения. Убрать?',
      () => saveDesign({ background_path: null }), 'Убрать');

  card.querySelectorAll('#seg-notify button').forEach((b) => {
    b.onclick = () => saveNotify(b.dataset.v === 'both');
  });

  card.querySelectorAll('#seg-material-cost button').forEach((b) => {
    b.onclick = () => saveMaterials(b.dataset.v === 'on');
  });

  card.querySelectorAll('#seg-owner-reset button').forEach((b) => {
    b.onclick = () => {
      const on = b.dataset.v === 'on';
      if (on && !settings.auth?.allow_owner_reset) {
        return confirmDialog('Перевыпуск пароля владельцем',
          'Владелец компании сможет в любой момент отключить от приложения ' +
          'всех своих сотрудников — без участия менеджера. Разрешить?',
          () => saveOwnerReset(true), 'Разрешить');
      }
      saveOwnerReset(on);
    };
  });

  card.querySelectorAll('#seg-fp button').forEach((b) => {
    b.onclick = () => saveFrontpad({ enabled: b.dataset.v === 'on' });
  });
  card.querySelectorAll('#seg-fp-sim button').forEach((b) => {
    b.onclick = () => {
      const sim = b.dataset.v === 'on';
      if (!sim && settings.frontpad?.simulation !== false) {
        return confirmDialog('Боевой режим FrontPad',
          'С этого момента каждый подтверждённый заказ будет создаваться в FrontPad по-настоящему. Включить?',
          () => saveFrontpad({ simulation: false }), 'Включить');
      }
      saveFrontpad({ simulation: sim });
    };
  });
  card.querySelectorAll('#seg-fp-verbose button').forEach((b) => {
    b.onclick = () => saveFrontpad({ verbose: b.dataset.v === 'on' });
  });
  const fpDeliv = card.querySelector('#fp-deliv');
  if (fpDeliv) fpDeliv.onchange = () => saveFrontpad({ delivery_time: fpDeliv.value });

  card.querySelector('#fp-test').onclick = runFpTest;
  card.querySelector('#fp-log-refresh').onclick = loadFpLog;
  card.querySelector('#bk-create').onclick = createBackupNow;
  wireBackups(card.querySelector('#bk-list'));

  body.append(card);
  if (orphans.length) body.querySelector('#settings-error').append(orphanBox());

  // Only the fields that were not there a moment ago slide in.
  if (cutoffOn && shown.cutoff === false) markEntering(body, '#cutoff-time, #seg-lock, #sel-after');
  if (blocking && shown.blocking === false) markEntering(body, '#resume-time');
  if (fpOn && shown.fp === false) markEntering(body, '#seg-fp-sim, #fp-deliv, #seg-fp-verbose');
  shown = { cutoff: cutoffOn, blocking, fp: fpOn };

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

/* Saving the address also moves the bot's webhook to it, so the answer says
   whether Telegram took it — a saved address the bot is not on is worth a
   red toast, not a green one. */
async function saveServer(raw) {
  try {
    const res = await api.put('/api/admin/settings/server', { public_url: raw });
    settle('server', res.value);
    if (res.webhook && !res.webhook.ok) {
      toast(`Адрес сохранён, но Telegram не принял его: ${res.webhook.description || 'ошибка'}`, 'err');
    } else {
      toast(res.webhook ? 'Адрес сохранён, бот переключён на него' : 'Адрес сохранён');
    }
  } catch (e) {
    toast(e.message, 'err');
  }
}

/* The server cleans up what was pasted (@name, t.me links) and answers with
   the username it kept, which the field then shows. */
async function saveContact(raw) {
  try {
    const res = await api.put('/api/admin/settings/contact', { manager_username: raw });
    settle('contact', res.value);
    toast(res.value.manager_username ? 'Сохранено' : 'Кнопка «Связаться с менеджером» убрана');
  } catch (e) {
    toast(e.message, 'err');
  }
}

async function saveOwnerReset(allow) {
  const before = settings.auth;
  settings.auth = { ...settings.auth, allow_owner_reset: allow };
  draw();
  try {
    const res = await api.put('/api/admin/settings/auth', { allow_owner_reset: allow });
    settle('auth', res.value);
    toast('Настройка сохранена');
  } catch (e) {
    settings.auth = before;
    draw();
    toast(e.message, 'err');
  }
}

async function saveMaterials(useCost) {
  const before = settings.materials;
  settings.materials = { ...settings.materials, use_cost: useCost };
  draw();
  try {
    const res = await api.put('/api/admin/settings/materials', { use_cost: useCost });
    settle('materials', res.value);
    toast('Настройка сохранена');
  } catch (e) {
    settings.materials = before;
    draw();
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

/* Upload first, then point the setting at it. The server removes the
   picture being replaced; an upload the save refused is removed here. */
async function uploadBackground(f) {
  if (!f) return;
  const hint = root?.querySelector('#bg-hint');
  if (f.size > 5 * 1024 * 1024) { if (hint) hint.textContent = 'Файл больше 5 МБ'; return; }
  if (hint) hint.textContent = 'Загрузка…';

  let path;
  try {
    // raw body, not multipart: one file and no form fields to encode
    const res = await fetch('/api/admin/images?folder=design', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': f.type },
      body: f
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Не удалось загрузить');
    path = data.path;
  } catch (e) {
    if (hint) hint.textContent = e.message;
    return;
  }

  if (!await saveDesign({ background_path: path })) {
    api.del(`/api/admin/images?path=${encodeURIComponent(path)}`).catch(() => {});
  }
}

async function saveDesign(patch) {
  const before = settings.design;
  try {
    const res = await api.put('/api/admin/settings/design', patch);
    settings.design = res.value;
    draw();
    toast('Настройка сохранена');
    return true;
  } catch (e) {
    settings.design = before;
    draw();
    toast(e.message, 'err');
    return false;
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

/* ── backups ───────────────────────────────────────────────────────── */

const KIND_LABEL = {
  daily: 'ежедневная',
  manual: 'вручную',
  'pre-restore': 'перед восстановлением',
  'pre-import': 'перед загрузкой данных'   // older backups only; the import is gone
};

const backupWhen = (b) =>
  new Date(b.created_at).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' });

function fmtSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} КБ`;
  return `${(n / 1024 / 1024).toFixed(1).replace('.', ',')} МБ`;
}

function backupsHTML() {
  if (!backups) return '<div class="card__body hint">Загрузка…</div>';
  if (!backups.length) return '<div class="card__body hint">Копий пока нет.</div>';
  return `
    <table class="table">
      <thead><tr>
        <th style="width:150px">Когда</th><th>Тип</th>
        <th style="width:90px">Заказов</th><th style="width:90px">Картинок</th>
        <th style="width:90px">Размер</th><th style="width:140px"></th>
      </tr></thead>
      <tbody>${backups.map((b) => `
        <tr>
          <td class="num">${esc(backupWhen(b))}</td>
          <td>${esc(KIND_LABEL[b.kind] || b.kind)}</td>
          <td class="num">${b.rows?.orders ?? '—'}</td>
          <td class="num">${b.files ?? 0}</td>
          <td class="num">${fmtSize(b.bytes)}</td>
          <td><button class="btn btn--sm" data-restore="${esc(b.id)}">Восстановить</button></td>
        </tr>`).join('')}
      </tbody>
    </table>`;
}

function wireBackups(el) {
  el?.querySelectorAll('[data-restore]').forEach((btn) => {
    btn.onclick = () => confirmRestore(backups.find((b) => b.id === btn.dataset.restore));
  });
}

async function loadBackups() {
  try {
    backups = await api.get('/api/admin/backups', { fresh: true });
  } catch (e) {
    backups = [];
    toast(e.message, 'err');
  }
  const el = root?.querySelector('#bk-list');
  if (el) {
    el.innerHTML = backupsHTML();
    wireBackups(el);
  }
}

async function createBackupNow() {
  const btn = root?.querySelector('#bk-create');
  if (btn) btn.disabled = true;
  try {
    await api.post('/api/admin/backups', {});
    toast('Копия создана');
    await loadBackups();
  } catch (e) {
    toast(e.message, 'err');
  } finally {
    if (btn) btn.disabled = false;
  }
}

/* Twice, on purpose: a restore throws away everything since the copy. */
function confirmRestore(b) {
  if (!b) return;
  const when = backupWhen(b);
  confirmDialog('Восстановить копию',
    `Все текущие данные будут заменены копией от ${when}. Продолжить?`,
    () => {
      confirmDialog('Вы точно уверены?',
        `Всё, что изменилось после ${when}, пропадёт: заказы, пользователи, настройки и картинки. ` +
        'Текущие данные перед этим сохранятся в отдельную копию.',
        async () => {
          await api.post(`/api/admin/backups/${encodeURIComponent(b.id)}/restore`, { confirm: true });
          toast(`Восстановлено из копии от ${when}`);
          await load(true);
        }, 'Да, восстановить');
    }, 'Продолжить');
}

/* ── FrontPad: connection test and log ─────────────────────────────── */

function fpTestHTML() {
  if (!fpTest) return '';
  if (fpTest.loading) return '<p class="hint">Проверяю…</p>';
  if (!fpTest.ok) return `<div class="alert alert--err" style="margin:8px 0 0"><p>${esc(fpTest.error)}</p></div>`;
  return `<p class="hint" style="color:var(--ok, inherit)">Связь есть. Товаров в FrontPad: ${fpTest.products}.</p>
    ${fpTest.unknown?.length ? `
      <div class="alert alert--err" style="margin:8px 0 0">
        <div class="alert__title">FrontPad не знает эти артикулы</div>
        <ul class="alert__list">${fpTest.unknown.map((u) =>
          `<li>«${esc(u.name)}» — ${esc(u.article)}</li>`).join('')}</ul>
      </div>` : '<p class="hint">Все артикулы позиций найдены в FrontPad.</p>'}`;
}

async function runFpTest() {
  fpTest = { loading: true };
  const out = root?.querySelector('#fp-test-out');
  if (out) out.innerHTML = fpTestHTML();
  try {
    fpTest = await api.post('/api/admin/frontpad/test', {});
  } catch (e) {
    fpTest = { ok: false, error: e.message };
  }
  const again = root?.querySelector('#fp-test-out');
  if (again) again.innerHTML = fpTestHTML();
}

function fpLogHTML() {
  if (!fpLog) return '<div class="card__body hint">Загрузка…</div>';
  const warn = fpLog.configured ? '' :
    '<div class="card__body" style="padding-bottom:0"><p class="hint">FRONTPAD_APIKEY на сервере не задан — работает только симуляция.</p></div>';
  if (!fpLog.rows.length) return `${warn}<div class="card__body hint">Записей пока нет.</div>`;
  return `${warn}
    <table class="table">
      <thead><tr>
        <th style="width:150px">Когда</th><th style="width:80px">Заказ</th>
        <th style="width:130px">Итог</th><th>Подробности</th>
      </tr></thead>
      <tbody>${fpLog.rows.map((r) => {
        const verdict = r.action === 'skipped'
          ? '<span class="pill">пропущен</span>'
          : r.simulated
          ? `<span class="pill">${r.ok ? 'симуляция' : 'симуляция: ошибка'}</span>`
          : `<span class="pill ${r.ok ? 'pill--on' : 'pill--off'}">${r.ok ? 'отправлен' : 'ошибка'}</span>`;
        const detail = [
          r.action !== 'new_order' ? esc(r.action) : '',
          r.error ? `<b>${esc(r.error)}</b>` : '',
          r.request ? `<details><summary>запрос</summary><pre style="white-space:pre-wrap;margin:4px 0">${esc(JSON.stringify(r.request, null, 1))}</pre></details>` : '',
          r.response ? `<details><summary>ответ (HTTP ${r.http_status ?? '—'})</summary><pre style="white-space:pre-wrap;margin:4px 0">${esc(r.response.slice(0, 3000))}</pre></details>` : ''
        ].filter(Boolean).join('');
        return `<tr>
          <td class="num">${esc(new Date(r.created_at).toLocaleString('ru-RU'))}</td>
          <td class="num">${r.order_id ? `#${r.order_id}` : '—'}</td>
          <td>${verdict}</td>
          <td>${detail || '—'}</td>
        </tr>`;
      }).join('')}</tbody>
    </table>`;
}

async function loadFpLog() {
  try {
    fpLog = await api.get('/api/admin/frontpad/log?limit=50', { fresh: true });
  } catch (e) {
    fpLog = { configured: true, rows: [] };
    toast(e.message, 'err');
  }
  const el = root?.querySelector('#fp-log');
  if (el) el.innerHTML = fpLogHTML();
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
