import pg from 'pg';

/* Postgres, spoken to in the dialect the routes were written in.

   The app started on Supabase, and every query in it is a supabase-js chain:
   db.from('orders').select('*, companies(company_name)').eq('id', 1).maybeSingle().
   Rather than rewrite some hundred and fifty of them, this module takes the
   same chains, turns them into SQL against our own database and answers in the
   same { data, error } shape — so the call sites did not change, and neither
   did what they mean. Like supabase-js it never throws: a failed query comes
   back as `error`, with the Postgres code (23505 …) and message intact.

   Only what the code actually uses is here: select with plain columns and
   many-to-one embeds, insert, update, upsert, delete; eq, neq, gt, gte, lt,
   lte, like, ilike, is, in, not(is | eq | in); order, limit, range; single and
   maybeSingle. Anything else is refused rather than half-supported. */

const { Pool, types } = pg;

// bigint ids and chat ids as numbers (all well inside 2^53), dates as
// 'YYYY-MM-DD' rather than a Date at local midnight, timestamps as ISO text —
// the shapes the REST API used to return.
types.setTypeParser(20, (v) => Number(v));                         // int8
types.setTypeParser(1082, (v) => v);                               // date
const parseTimestamptz = types.getTypeParser(1184);
types.setTypeParser(1184, (v) => {                                 // timestamptz
  const d = parseTimestamptz(v);
  return Number.isNaN(d?.getTime?.()) ? v : d.toISOString();
});

if (!process.env.DATABASE_URL) {
  console.warn('[db] DATABASE_URL missing — DB calls will fail.');
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.DB_POOL_MAX) || 10
});
pool.on('error', (e) => console.error('[db] idle connection error:', e.message));

export const db = {
  from: (table) => new Query(table)
};

export function dbError(res, error, status = 400) {
  console.error('[db]', error);
  return res.status(status).json({ error: error.message || 'Database error' });
}

/* ── catalog ─────────────────────────────────────────────────────────────
   Column types and keys, read once from the database itself. They say which
   values are stored as JSON, what an upsert conflicts on, and which foreign
   key an embed like companies(company_name) joins through. */

let catalogPromise = null;

export const forgetCatalog = () => { catalogPromise = null; };

function catalog() {
  if (!catalogPromise) {
    catalogPromise = loadCatalog().catch((e) => {
      catalogPromise = null;
      throw e;
    });
  }
  return catalogPromise;
}

async function loadCatalog() {
  const [cols, keys] = await Promise.all([
    pool.query(`
      select c.relname as table_name, a.attname as column_name, t.typname as type_name
        from pg_attribute a
        join pg_class c on c.oid = a.attrelid
        join pg_namespace n on n.oid = c.relnamespace
        join pg_type t on t.oid = a.atttypid
       where n.nspname = 'public' and c.relkind in ('r', 'p', 'v')
         and a.attnum > 0 and not a.attisdropped`),
    pool.query(`
      select con.contype::text as kind, c.relname::text as table_name,
             f.relname::text as foreign_table,
             (select array_agg(a.attname::text order by k.ord)
                from unnest(con.conkey) with ordinality k(attnum, ord)
                join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.attnum
             )::text[] as columns,
             (select array_agg(a.attname::text order by k.ord)
                from unnest(con.confkey) with ordinality k(attnum, ord)
                join pg_attribute a on a.attrelid = con.confrelid and a.attnum = k.attnum
             )::text[] as foreign_columns
        from pg_constraint con
        join pg_class c on c.oid = con.conrelid
        join pg_namespace n on n.oid = c.relnamespace
        left join pg_class f on f.oid = con.confrelid
       where n.nspname = 'public' and con.contype in ('p', 'f')`)
  ]);

  const tables = new Map();
  const table = (name) => {
    if (!tables.has(name)) tables.set(name, { name, columns: new Map(), pk: [], fks: [] });
    return tables.get(name);
  };
  for (const r of cols.rows) table(r.table_name).columns.set(r.column_name, r.type_name);
  for (const r of keys.rows) {
    if (r.kind === 'p') table(r.table_name).pk = r.columns;
    else table(r.table_name).fks.push({
      columns: r.columns, table: r.foreign_table, references: r.foreign_columns
    });
  }
  return tables;
}

/* ── SQL pieces ──────────────────────────────────────────────────────── */

class QueryError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

const asError = (e) => ({
  message: e?.message || String(e),
  code: e?.code || null,
  details: e?.detail || e?.details || null,
  hint: e?.hint || null
});

const IDENT = /^[a-z_][a-z0-9_]*$/;
const JSON_TYPES = new Set(['json', 'jsonb']);

function quote(name) {
  if (!IDENT.test(name)) throw new QueryError(`Invalid identifier: ${name}`, 'PGRST100');
  return `"${name}"`;
}

function requireColumn(meta, name) {
  if (!meta.columns.has(name)) {
    throw new QueryError(`column ${meta.name}.${name} does not exist`, '42703');
  }
  return name;
}

/* 'status', or a path into a JSON column the way PostgREST writes one:
   'audience->>mode'. Keys are limited to letters, digits and _, so they can
   sit in the SQL as literals. */
function columnRef(alias, meta, spec) {
  const m = /^([a-z_][a-z0-9_]*)((?:->>?[A-Za-z0-9_]+)*)$/.exec(String(spec));
  if (!m) throw new QueryError(`Invalid column: ${spec}`, 'PGRST100');
  let sql = `${alias}.${quote(requireColumn(meta, m[1]))}`;
  for (const [, arrow, key] of m[2].matchAll(/(->>?)([A-Za-z0-9_]+)/g)) sql += `${arrow}'${key}'`;
  return sql;
}

// Splits 'id, companies(id, company_name)' on the commas outside parentheses.
function splitTop(list) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of String(list)) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

function selectList(tables, meta, alias, list, depth) {
  return splitTop(list || '*').map((part) => {
    if (part === '*') return `${alias}.*`;
    const embed = /^([a-z_][a-z0-9_]*)\s*\(([\s\S]*)\)$/.exec(part);
    if (embed) return embedded(tables, meta, alias, embed[1], embed[2], depth);
    return `${alias}.${quote(requireColumn(meta, part))}`;
  }).join(', ');
}

/* A many-to-one embed — users → companies(company_name) — as a correlated
   subquery, so each row carries the related row as an object, or null when
   there is none. */
function embedded(tables, meta, alias, name, inner, depth) {
  const target = tables.get(name);
  const fks = meta.fks.filter((f) => f.table === name && f.columns.length === 1);
  if (!target || fks.length !== 1) {
    throw new QueryError(
      `Could not find a single relationship between '${meta.name}' and '${name}'`, 'PGRST200');
  }
  const [fk] = fks;
  const sub = `e${depth}`;
  return `(select row_to_json(${sub}_row) from (` +
    `select ${selectList(tables, target, sub, inner, depth + 1)} from ${quote(name)} ${sub} ` +
    `where ${sub}.${quote(fk.references[0])} = ${alias}.${quote(fk.columns[0])}` +
    `) ${sub}_row) as ${quote(name)}`;
}

function isLiteral(value) {
  if (value === null) return 'null';
  if (value === true) return 'true';
  if (value === false) return 'false';
  throw new QueryError(`is() takes null, true or false, not ${value}`, 'PGRST100');
}

const encode = (meta, column, value) => {
  if (value === null || value === undefined) return null;
  return JSON_TYPES.has(meta.columns.get(column)) ? JSON.stringify(value) : value;
};

const TOO_MANY = (n) => ({
  message: 'JSON object requested, multiple (or no) rows returned',
  code: 'PGRST116',
  details: `The result contains ${n} rows`,
  hint: null
});

/* ── the builder ─────────────────────────────────────────────────────── */

class Query {
  constructor(table) {
    this.table = table;
    this.op = 'select';
    this.columns = '*';
    this.returning = false;      // a mutation followed by .select()
    this.values = null;
    this.conflict = {};
    this.filters = [];           // (ref, param) => sql
    this.orders = [];
    this.limitN = null;
    this.offsetN = null;
    this.mode = 'many';
    this.failure = null;
  }

  select(columns = '*') {
    if (this.op !== 'select') this.returning = true;
    this.columns = columns;
    return this;
  }

  insert(values) { return this.mutate('insert', values); }
  update(values) { return this.mutate('update', values); }
  delete() { return this.mutate('delete', null); }

  upsert(values, { onConflict, ignoreDuplicates = false } = {}) {
    this.conflict = { onConflict, ignoreDuplicates };
    return this.mutate('upsert', values);
  }

  mutate(op, values) {
    this.op = op;
    this.values = values;
    return this;
  }

  eq(column, value) { return this.compare(column, '=', value); }
  neq(column, value) { return this.compare(column, '<>', value); }
  gt(column, value) { return this.compare(column, '>', value); }
  gte(column, value) { return this.compare(column, '>=', value); }
  lt(column, value) { return this.compare(column, '<', value); }
  lte(column, value) { return this.compare(column, '<=', value); }
  like(column, pattern) { return this.compare(column, 'like', pattern); }
  ilike(column, pattern) { return this.compare(column, 'ilike', pattern); }

  is(column, value) {
    return this.filter((ref) => `${ref(column)} is ${isLiteral(value)}`);
  }

  in(column, list) {
    const values = Array.isArray(list) ? list : [];
    return this.filter((ref, param) => `${ref(column)} = any(${param(values)})`);
  }

  not(column, operator, value) {
    if (operator === 'is') return this.filter((ref) => `${ref(column)} is not ${isLiteral(value)}`);
    if (operator === 'eq') return this.filter((ref, param) => `not (${ref(column)} = ${param(value)})`);
    if (operator === 'in') {
      const values = Array.isArray(value) ? value : [];
      return this.filter((ref, param) => `not (${ref(column)} = any(${param(values)}))`);
    }
    this.failure = new QueryError(`not(…, '${operator}') is not supported`, 'PGRST100');
    return this;
  }

  compare(column, operator, value) {
    return this.filter((ref, param) => `${ref(column)} ${operator} ${param(value)}`);
  }

  filter(fn) {
    this.filters.push(fn);
    return this;
  }

  order(column, { ascending = true, nullsFirst } = {}) {
    this.orders.push({ column, ascending, nullsFirst });
    return this;
  }

  limit(n) {
    this.limitN = n;
    return this;
  }

  range(from, to) {
    this.offsetN = from;
    this.limitN = to - from + 1;
    return this;
  }

  single() {
    this.mode = 'single';
    return this;
  }

  maybeSingle() {
    this.mode = 'maybe';
    return this;
  }

  then(onFulfilled, onRejected) {
    return this.run().then(onFulfilled, onRejected);
  }

  async run() {
    try {
      if (this.failure) throw this.failure;
      const tables = await catalog();
      const meta = tables.get(this.table);
      if (!meta) throw new QueryError(`relation "${this.table}" does not exist`, '42P01');

      const params = [];
      const param = (v) => {
        params.push(v);
        return `$${params.length}`;
      };
      const { text, rows: wantsRows } = this.build(tables, meta, param);
      const { rows } = await pool.query(text, params);
      return this.answer(wantsRows ? rows : null);
    } catch (e) {
      return { data: null, error: asError(e), count: null, status: 400, statusText: '' };
    }
  }

  answer(rows) {
    const ok = (data) => ({ data, error: null, count: null, status: 200, statusText: '' });
    const bad = (error) => ({ data: null, error, count: null, status: 406, statusText: '' });
    if (rows === null) return ok(null);
    if (this.mode === 'single') return rows.length === 1 ? ok(rows[0]) : bad(TOO_MANY(rows.length));
    if (this.mode === 'maybe') return rows.length > 1 ? bad(TOO_MANY(rows.length)) : ok(rows[0] ?? null);
    return ok(rows);
  }

  build(tables, meta, param) {
    const T = 't';
    const ref = (column) => columnRef(T, meta, column);
    const where = this.filters.length
      ? ` where ${this.filters.map((f) => f(ref, param)).join(' and ')}`
      : '';
    const from = `${quote(this.table)} as ${T}`;

    const returning = (statement) => (this.returning
      ? { text: `with ${T} as (${statement} returning ${T}.*) ` +
                `select ${selectList(tables, meta, T, this.columns, 1)} from ${T}`, rows: true }
      : { text: statement, rows: false });

    switch (this.op) {
      case 'select':
        return {
          text: `select ${selectList(tables, meta, T, this.columns, 1)} from ${from}${where}${this.tail(ref)}`,
          rows: true
        };

      case 'delete':
        return returning(`delete from ${from}${where}`);

      case 'update': {
        const entries = Object.entries(this.values || {}).filter(([, v]) => v !== undefined);
        // nothing to change: answer with the rows as they stand
        if (!entries.length) {
          return {
            text: `select ${this.returning ? selectList(tables, meta, T, this.columns, 1) : '1'} from ${from}${where}`,
            rows: this.returning
          };
        }
        const set = entries
          .map(([k, v]) => `${quote(requireColumn(meta, k))} = ${param(encode(meta, k, v))}`)
          .join(', ');
        return returning(`update ${from} set ${set}${where}`);
      }

      case 'insert':
      case 'upsert': {
        const list = (Array.isArray(this.values) ? this.values : [this.values]).map((r) => r || {});
        if (!list.length) return { text: 'select 1 where false', rows: this.returning };

        const keys = [...new Set(list.flatMap((r) => Object.keys(r).filter((k) => r[k] !== undefined)))];
        keys.forEach((k) => requireColumn(meta, k));

        let statement;
        if (!keys.length) {
          if (list.length > 1) throw new QueryError('Cannot insert several empty rows', 'PGRST100');
          statement = `insert into ${from} default values`;
        } else {
          const rows = list.map((r) => `(${keys.map((k) =>
            (r[k] === undefined ? 'default' : param(encode(meta, k, r[k])))).join(', ')})`);
          statement = `insert into ${from} (${keys.map(quote).join(', ')}) values ${rows.join(', ')}`;
        }

        if (this.op === 'upsert') {
          const target = this.conflict.onConflict
            ? String(this.conflict.onConflict).split(',').map((s) => s.trim())
            : meta.pk;
          if (!target.length) throw new QueryError(`${meta.name} has no key to upsert on`, 'PGRST100');
          target.forEach((k) => requireColumn(meta, k));
          const updates = keys.filter((k) => !target.includes(k));
          statement += ` on conflict (${target.map(quote).join(', ')}) ` +
            (this.conflict.ignoreDuplicates || !updates.length
              ? 'do nothing'
              : `do update set ${updates.map((k) => `${quote(k)} = excluded.${quote(k)}`).join(', ')}`);
        }
        return returning(statement);
      }

      default:
        throw new QueryError(`Unknown operation ${this.op}`, 'PGRST100');
    }
  }

  tail(ref) {
    let sql = '';
    if (this.orders.length) {
      sql += ' order by ' + this.orders.map((o) =>
        `${ref(o.column)} ${o.ascending ? 'asc' : 'desc'}` +
        (o.nullsFirst === undefined ? '' : o.nullsFirst ? ' nulls first' : ' nulls last')).join(', ');
    }
    if (this.limitN !== null) sql += ` limit ${whole(this.limitN)}`;
    if (this.offsetN) sql += ` offset ${whole(this.offsetN)}`;
    return sql;
  }
}

function whole(n) {
  const v = Math.trunc(Number(n));
  if (!Number.isFinite(v) || v < 0) throw new QueryError(`Invalid limit/offset: ${n}`, 'PGRST100');
  return v;
}
