import { api } from '../api.js';
import { h, esc, toast } from '../ui.js';
import { paintIcons } from '../icons.js';

/* First real setting: how the mini-app lists the catalog. Grouping by
   category only works if every item has one, so the save is allowed to fail
   with the list of offenders and we render it inline. */

let settings = {
  catalog: { group_by_category: false, show_images: false },
  notifications: { notify_owner: true }
};
let orphans = [];
let root;

export const settingsPanel = {
  id: 'settings',
  label: 'Настройки',
  icon: 'settings',
  title: 'Настройки',
  subtitle: 'Общие настройки приложения',

  actions: () => [
    h(`<button class="btn btn--ghost btn--icon" id="set-refresh" title="Обновить"><span data-icon="refresh"></span></button>`)
  ],

  async render(container) {
    root = container;
    root.append(h(`<div id="settings-body"></div>`));
    document.getElementById('set-refresh')?.addEventListener('click', load);
    await load();
  }

};

/* h() returns one element; this screen renders two sibling cards. */
function frag(html) {
  const t = document.createElement('div');
  t.innerHTML = html.trim();
  return t;
}

async function load() {
  try {
    settings = await api.get('/api/admin/settings');
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
    </div>`);

  card.querySelectorAll('#seg-catalog button').forEach((b) => {
    b.onclick = () => save(b.dataset.v === 'grouped');
  });

  card.querySelectorAll('#seg-images button').forEach((b) => {
    b.onclick = () => saveImages(b.dataset.v === 'on');
  });

  card.querySelectorAll('#seg-notify button').forEach((b) => {
    b.onclick = () => saveNotify(b.dataset.v === 'both');
  });

  body.append(card);
  if (orphans.length) body.querySelector('#settings-error').append(orphanBox());
  paintIcons(body);
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
  try {
    const res = await api.put('/api/admin/settings/catalog', { group_by_category: grouped });
    settings.catalog = res.value;
    orphans = [];
    draw();
    toast('Настройка сохранена');
  } catch (e) {
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
  try {
    const res = await api.put('/api/admin/settings/notifications', { notify_owner: notifyOwner });
    settings.notifications = res.value;
    draw();
    toast('Настройка сохранена');
  } catch (e) {
    toast(e.message, 'err');
  }
}

async function saveImages(show) {
  try {
    const res = await api.put('/api/admin/settings/catalog', { show_images: show });
    settings.catalog = res.value;
    draw();
    toast('Настройка сохранена');
  } catch (e) {
    toast(e.message, 'err');
  }
}
