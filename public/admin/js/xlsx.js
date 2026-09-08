/* Minimal .xlsx writer: enough of the OOXML spreadsheet format to hand the
   admin a file Excel opens natively, with no runtime dependency and none of
   the CSV separator/encoding guesswork. Values are written as numbers or
   inline strings; the first row of every sheet is the bold header.

   Excel refuses a zip whose parts are stored rather than deflated, so every
   entry is a real deflate stream — built from uncompressed deflate blocks,
   which needs no compressor and costs 5 bytes per 64 KB. These sheets run to
   a few hundred rows, so the size that buys back is not worth a Huffman
   coder. */

const enc = new TextEncoder();

/* ── zip ────────────────────────────────────────────────────────────────── */

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/* Growable little-endian byte sink. */
function sink() {
  let buf = new Uint8Array(1 << 16);
  let len = 0;
  const fit = (n) => {
    if (len + n <= buf.length) return;
    let size = buf.length;
    while (size < len + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(buf.subarray(0, len));
    buf = next;
  };
  return {
    get length() { return len; },
    u16(v) { fit(2); buf[len++] = v & 0xff; buf[len++] = (v >>> 8) & 0xff; },
    u32(v) {
      fit(4);
      buf[len++] = v & 0xff; buf[len++] = (v >>> 8) & 0xff;
      buf[len++] = (v >>> 16) & 0xff; buf[len++] = (v >>> 24) & 0xff;
    },
    bytes(b) { fit(b.length); buf.set(b, len); len += b.length; },
    done() { return buf.slice(0, len); }
  };
}

/* A raw deflate stream of uncompressed blocks: per block a 3-bit header
   (BFINAL, BTYPE=00) padded to a byte, then LEN and its complement, then the
   bytes verbatim. Valid deflate, no compression. */
function deflateRaw(data) {
  const MAX = 0xffff;
  const blocks = Math.max(1, Math.ceil(data.length / MAX));
  const out = new Uint8Array(data.length + blocks * 5);
  let at = 0;

  for (let i = 0; i < blocks; i++) {
    const from = i * MAX;
    const len = Math.min(MAX, data.length - from);
    out[at++] = i === blocks - 1 ? 1 : 0;
    out[at++] = len & 0xff;
    out[at++] = (len >>> 8) & 0xff;
    out[at++] = ~len & 0xff;
    out[at++] = (~len >>> 8) & 0xff;
    out.set(data.subarray(from, from + len), at);
    at += len;
  }
  return out;
}

/* `files` is [{ name, text }]. */
function zip(files) {
  const out = sink();
  const dir = [];

  // A fixed DOS timestamp: Excel ignores it, and a real clock adds nothing.
  const time = 0;
  const date = ((2020 - 1980) << 9) | (1 << 5) | 1;

  for (const f of files) {
    const name = enc.encode(f.name);
    const data = enc.encode(f.text);
    const body = deflateRaw(data);
    const sum = crc32(data);
    const at = out.length;

    out.u32(0x04034b50);
    out.u16(20); out.u16(0); out.u16(8);           // version, no flags, deflate
    out.u16(time); out.u16(date);
    out.u32(sum); out.u32(body.length); out.u32(data.length);
    out.u16(name.length); out.u16(0);
    out.bytes(name); out.bytes(body);

    dir.push({ name, sum, csize: body.length, size: data.length, at });
  }

  const dirAt = out.length;
  for (const e of dir) {
    out.u32(0x02014b50);
    out.u16(20); out.u16(20); out.u16(0); out.u16(8);
    out.u16(time); out.u16(date);
    out.u32(e.sum); out.u32(e.csize); out.u32(e.size);
    out.u16(e.name.length); out.u16(0); out.u16(0);
    out.u16(0); out.u16(0); out.u32(0);
    out.u32(e.at);
    out.bytes(e.name);
  }

  // measured before the record itself starts, or it counts its own bytes
  const dirSize = out.length - dirAt;

  out.u32(0x06054b50);
  out.u16(0); out.u16(0);
  out.u16(dir.length); out.u16(dir.length);
  out.u32(dirSize); out.u32(dirAt);
  out.u16(0);
  return out.done();
}

/* ── sheet xml ──────────────────────────────────────────────────────────── */

// Control characters are illegal in XML and make Excel reject the whole file.
const CTRL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;

const xmlEsc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(CTRL, '');

function colName(i) {
  let n = i + 1;
  let out = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

const isNumber = (v) =>
  typeof v === 'number' ? Number.isFinite(v)
    : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v));

/* ── styles ─────────────────────────────────────────────────────────────
   A cell is either a bare value or { v, s } where s describes how it looks:

     { b, i }            bold / italic
     { color: 'FF0000' } font colour, RRGGBB
     { size, font }      point size and typeface
     { align, valign }   'left' | 'center' | 'right', 'top' | 'center' | 'bottom'
     { wrap }            wrap text in the cell
     { fmt }             number format, e.g. '0.00'
     { box }             thin border on all four sides
     { under }           thin border along the bottom only

   Styles are deduplicated: the workbook ends up with one cellXfs entry per
   distinct look, however many cells wear it. */

function styles() {
  const fonts = ['<font><sz val="11"/><name val="Calibri"/></font>'];
  const borders = ['<border><left/><right/><top/><bottom/><diagonal/></border>'];
  const fmts = [];                       // custom number formats, ids from 164
  const xfs = ['<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'];
  const seen = new Map([['', 0]]);

  const push = (list, xml) => {
    const at = list.indexOf(xml);
    if (at >= 0) return at;
    list.push(xml);
    return list.length - 1;
  };

  return {
    /* Returns the cellXfs index for a style descriptor. */
    id(s) {
      if (!s) return 0;
      const key = JSON.stringify(s, Object.keys(s).sort());
      if (seen.has(key)) return seen.get(key);

      const fontId = push(fonts, '<font>' +
        (s.b ? '<b/>' : '') + (s.i ? '<i/>' : '') +
        `<sz val="${s.size || 11}"/>` +
        (s.color ? `<color rgb="FF${s.color}"/>` : '') +
        `<name val="${s.font || 'Calibri'}"/>` +
        '</font>');

      const edge = (name, on) =>
        (on ? `<${name} style="thin"><color rgb="FF000000"/></${name}>` : `<${name}/>`);
      const borderId = push(borders,
        '<border>' +
        edge('left', s.box) + edge('right', s.box) + edge('top', s.box) +
        edge('bottom', s.box || s.under) + '<diagonal/></border>');

      let numFmtId = 0;
      if (s.fmt) {
        const at = push(fmts, s.fmt);
        numFmtId = 164 + at;
      }

      const align = (s.align || s.valign || s.wrap)
        ? `<alignment${s.align ? ` horizontal="${s.align}"` : ''}` +
          `${s.valign ? ` vertical="${s.valign}"` : ''}` +
          `${s.wrap ? ' wrapText="1"' : ''}/>`
        : '';

      xfs.push(`<xf numFmtId="${numFmtId}" fontId="${fontId}" fillId="0" ` +
        `borderId="${borderId}" xfId="0" applyFont="1" applyBorder="1"` +
        `${numFmtId ? ' applyNumberFormat="1"' : ''}` +
        `${align ? ' applyAlignment="1"' : ''}>${align}</xf>`);

      const at = xfs.length - 1;
      seen.set(key, at);
      return at;
    },

    /* Child order inside styleSheet is fixed by the schema; Excel rejects the
       file outright if numFmts/fonts/fills/borders/xfs come out of sequence. */
    xml() {
      return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
${fmts.length ? `<numFmts count="${fmts.length}">${fmts.map((f, i) =>
  `<numFmt numFmtId="${164 + i}" formatCode="${xmlEsc(f)}"/>`).join('')}</numFmts>` : ''}
<fonts count="${fonts.length}">${fonts.join('')}</fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="${borders.length}">${borders.join('')}</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="${xfs.length}">${xfs.join('')}</cellXfs>
</styleSheet>`;
    }
  };
}

/* ── sheets ─────────────────────────────────────────────────────────────── */

function cellXml(cell, ref, reg, fallback) {
  const wrapped = cell !== null && typeof cell === 'object' && !Array.isArray(cell);
  const value = wrapped ? cell.v : cell;
  const id = wrapped && cell.s ? reg.id(cell.s) : fallback;
  const s = id ? ` s="${id}"` : '';

  if (value === null || value === undefined || value === '') return `<c r="${ref}"${s}/>`;
  if (isNumber(value)) return `<c r="${ref}"${s}><v>${Number(value)}</v></c>`;
  return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${xmlEsc(value)}</t></is></c>`;
}

/* `header` bolds and freezes the first row — right for an export, wrong for a
   document like a накладная, which sets its own look cell by cell. */
function sheetXml(sheet, reg) {
  const { rows = [], cols, merges, header = true } = sheet;
  const headerId = header ? reg.id({ b: true }) : 0;

  const body = rows.map((row, r) => {
    const cells = (row || [])
      .map((v, c) => cellXml(v, `${colName(c)}${r + 1}`, reg, r === 0 ? headerId : 0))
      .join('');
    return `<row r="${r + 1}">${cells}</row>`;
  }).join('');

  const colsXml = cols?.length
    ? `<cols>${cols.map((w, i) =>
        `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>`
    : '<cols><col min="1" max="40" width="18" customWidth="1"/></cols>';

  const views = header
    ? '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
    : '<sheetViews><sheetView workbookViewId="0"/></sheetViews>';

  // mergeCells belongs after sheetData, or Excel refuses the sheet
  const mergeXml = merges?.length
    ? `<mergeCells count="${merges.length}">${merges.map((m) =>
        `<mergeCell ref="${m}"/>`).join('')}</mergeCells>`
    : '';

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
${views}
${colsXml}
<sheetData>${body}</sheetData>${mergeXml}</worksheet>`;
}

/* Excel refuses these characters in a tab name, and anything past 31 chars. */
const sheetName = (name, i) =>
  String(name || '').replace(/[\\/*?:[\]]/g, ' ').trim().slice(0, 31) || `Лист${i + 1}`;

function book(sheets) {
  const names = sheets.map((s, i) => sheetName(s.name, i));

  // sheets first: writing them is what registers the styles the sheet uses
  const reg = styles();
  const sheetParts = sheets.map((s, i) => ({
    name: `xl/worksheets/sheet${i + 1}.xml`,
    text: sheetXml(s, reg)
  }));

  return [
    { name: '[Content_Types].xml',
      text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${names.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}
</Types>` },

    { name: '_rels/.rels',
      text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>` },

    { name: 'xl/workbook.xml',
      text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${names.map((n, i) => `<sheet name="${xmlEsc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>
</workbook>` },

    { name: 'xl/_rels/workbook.xml.rels',
      text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${names.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}
<Relationship Id="rId${names.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>` },

    { name: 'xl/styles.xml', text: reg.xml() },

    ...sheetParts
  ];
}

/* ── public ─────────────────────────────────────────────────────────────── */

/* `sheets` is either a rows array (one sheet) or [{ name, rows, cols, merges,
   header }]. Options:

     sheetName  tab name when `sheets` is a bare rows array
     stamp      append the date to the file name (default true) — an export is
                a snapshot and wants it; a document named «Расходная накладная
                №4» already identifies itself and does not. */
export function downloadXlsx(fileName, sheets, opts = {}) {
  const { sheetName: label = 'Лист1', stamp = true } = opts;
  const list = Array.isArray(sheets) && Array.isArray(sheets[0])
    ? [{ name: label, rows: sheets }]
    : sheets;

  const blob = new Blob([zip(book(list))], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = stamp
    ? `${fileName}_${new Date().toISOString().slice(0, 10)}.xlsx`
    : `${fileName}.xlsx`;
  a.click();
  URL.revokeObjectURL(url);
}
