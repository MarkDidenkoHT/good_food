import { placeholder } from '../ui.js';

// Stage-1 stubs. Each keeps its slot in the nav and its title so the layout
// is exercised end-to-end before the real features land.
const stub = (id, label, icon, subtitle, text) => ({
  id, label, icon, title: label, subtitle,
  render(container) { container.append(placeholder(label, text)); }
});

export const messagesPanel = stub(
  'messages', 'Сообщения', 'messages',
  'Рассылки пользователям',
  'Отправка сообщений и уведомлений пользователям через Telegram-бот.'
);

export const cronPanel = stub(
  'cron', 'Cron', 'cron',
  'Регулярные задачи',
  'Расписания: напоминания о заказе, сводки для менеджера, авто-закрытие дня.'
);
