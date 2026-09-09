import { downloadXlsx } from './xlsx.js';

/* Накладная for one order, laid out to match the blank the client works from.

   Row positions are fixed relative to the item list, so a накладная with two
   lines and one with twenty both read the same way: the signature block sits
   a set number of rows below ИТОГО rather than at a hard-coded row.

   A return reverses who hands over and who receives — goods travel back to
   us — so the two parties and the two signature lines swap with the kind. */

/* The supplier's own details. One place to change them; nothing else in the
   panel knows the company's legal name or address. */
export const SUPPLIER = {
  name: 'ООО "Гуд Фуд"',
  address: 'ул. Одесская 70'
};

const TITLE = { order: 'Расходная накладная', return: 'Возвратная накладная' };

// column widths, A..F, in characters
const COLS = [8, 46, 12, 12, 12, 14];

const RED = 'FF0000';

/* dd.mm.yyyy with the trailing 'г' the blank uses. */
function dateLabel(iso) {
  const d = iso ? new Date(iso) : new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}г`;
}

const row = (cells) => cells;
const blank = () => [];

/* Every cell of the table carries the same thin box, so the grid closes up
   even where a cell is empty. */
const boxed = (v, extra = {}) => ({ v, s: { box: true, ...extra } });

export function buildInvoice(order, companyName) {
  const kind = order.kind === 'return' ? 'return' : 'order';
  const lines = Array.isArray(order.items) ? order.items : [];
  const customer = companyName || order.companies?.company_name || '';

  // who hands over and who takes delivery
  const from = kind === 'return' ? customer : SUPPLIER.name;
  const to = kind === 'return' ? SUPPLIER.name : customer;

  const rows = [
    // 1 — title, number
    row([null, TITLE[kind], null, '№', { v: order.id, s: { b: true, color: RED } }]),
    // 2 — address and date
    row([null, { v: `${SUPPLIER.address}   от`, s: { align: 'right' } },
         { v: dateLabel(order.created_at), s: { b: true, color: RED } },
         // A return made from a past order says which one, on the document
         // the two parties actually sign — that is where the claim has to be
         // checkable. Absent on a return composed from the catalogue.
         ...(kind === 'return' && order.source_order_id
           ? ['по заказу', { v: `№${order.source_order_id}`, s: { b: true, color: RED } }]
           : [])]),
    // 3 — who is handing the goods over
    row([null, 'Отпущено:', from]),
    blank(),
    // 5 — who is taking delivery
    row([null, 'Получено:', to]),
    // 6 — table head
    row([boxed('№ п/п'), boxed('Наименование'), boxed('ед.изм.'),
         boxed('кол-во'), boxed('Цена'), boxed('Сумма')])
  ];

  lines.forEach((l, i) => {
    const qty = Number(l.qty) || 0;
    const cost = Number(l.cost) || 0;
    rows.push(row([
      boxed(i + 1), boxed(l.name || ''), boxed('шт'),
      boxed(qty), boxed(cost), boxed(qty * cost)
    ]));
  });

  // ИТОГО closes the table, so it is boxed like the rest of it
  const total = order.total ?? lines.reduce(
    (sum, l) => sum + (Number(l.qty) || 0) * (Number(l.cost) || 0), 0);
  rows.push(row([boxed(''), boxed('ИТОГО:'), boxed(''), boxed(''), boxed(''), boxed(total)]));

  // the rule the signature is written on runs across D..F
  const rule = () => ({ v: '', s: { under: true } });

  rows.push(blank());
  rows.push(row([null, 'Отпустил', null, rule(), rule(), rule()]));
  rows.push(row([null, from]));
  rows.push(blank());
  rows.push(blank());
  rows.push(blank());
  rows.push(row([null, 'Принял', null, rule(), rule(), rule()]));
  rows.push(row([null, to]));

  return {
    name: TITLE[kind],
    fileName: `${TITLE[kind]} №${order.id}`,
    sheet: { name: TITLE[kind], rows, cols: COLS, header: false }
  };
}

export function downloadInvoice(order, companyName) {
  const inv = buildInvoice(order, companyName);
  downloadXlsx(inv.fileName, [inv.sheet], { stamp: false });
  return inv;
}
