import { placeholder } from '../ui.js';

// Stage-1 stubs. Each keeps its slot in the nav, its title, and its own
// right-panel tab so the layout is exercised end-to-end before the real
// features land.
const stub = (id, label, icon, subtitle, text, asideNote) => ({
  id, label, icon, title: label, subtitle,
  render(container) { container.append(placeholder(label, text)); },
  asideTabs: [{
    id: `${id}-opts`,
    label: 'Опции',
    icon,
    render: () => placeholder('Скоро', asideNote)
  }]
});

export const ordersPanel = stub(
  'orders', 'Заказы', 'orders',
  'Входящие заказы компаний',
  'Раздел заказов появится после подключения каталога и корзины мини-приложения.',
  'Здесь будут фильтры по статусу, дате и компании.'
);

export const messagesPanel = stub(
  'messages', 'Сообщения', 'messages',
  'Рассылки пользователям',
  'Отправка сообщений и уведомлений пользователям через Telegram-бот.',
  'Здесь будут шаблоны сообщений и выбор получателей.'
);

export const cronPanel = stub(
  'cron', 'Cron', 'cron',
  'Регулярные задачи',
  'Расписания: напоминания о заказе, сводки для менеджера, авто-закрытие дня.',
  'Здесь будут журнал запусков и ручной запуск задач.'
);
