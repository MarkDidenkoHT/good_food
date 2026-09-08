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

function cellXml(value, ref, style) {
  const s = style ? ` s="${style}"` : '';
  if (value === null || value === undefined || value === '') return `<c r="${ref}"${s}/>`;
  if (isNumber(value)) return `<c r="${ref}"${s}><v>${Number(value)}</v></c>`;
  return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${xmlEsc(value)}</t></is></c>`;
}

function sheetXml(rows) {
  const body = rows.map((row, r) => {
    const cells = (row || [])
      .map((v, c) => cellXml(v, `${colName(c)}${r + 1}`, r === 0 ? 1 : 0))
      .join('');
    return `<row r="${r + 1}">${cells}</row>`;
  }).join('');

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<cols><col min="1" max="40" width="18" customWidth="1"/></cols>
<sheetData>${body}</sheetData></worksheet>`;
}

/* Excel refuses these characters in a tab name, and anything past 31 chars. */
const sheetName = (name, i) =>
  String(name || '').replace(/[\\/*?:[\]]/g, ' ').trim().slice(0, 31) || `Лист${i + 1}`;

function book(sheets) {
  const names = sheets.map((s, i) => sheetName(s.name, i));

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

    // two cell formats: plain (0) and the bold header (1)
    { name: 'xl/styles.xml',
      text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>
</styleSheet>` },

    ...sheets.map((s, i) => ({
      name: `xl/worksheets/sheet${i + 1}.xml`,
      text: sheetXml(s.rows || [])
    }))
  ];
}

/* ── public ─────────────────────────────────────────────────────────────── */

/* `sheets` is either a rows array (one sheet) or [{ name, rows }]. */
export function downloadXlsx(fileName, sheets, sheetLabel = 'Лист1') {
  const list = Array.isArray(sheets) && Array.isArray(sheets[0])
    ? [{ name: sheetLabel, rows: sheets }]
    : sheets;

  const blob = new Blob([zip(book(list))], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${fileName}_${new Date().toISOString().slice(0, 10)}.xlsx`;
  a.click();
  URL.revokeObjectURL(url);
}
