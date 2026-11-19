// Notion to-dos via the data-source query API (read-only integration token).

import { HOSTS } from './config.js';
import { dateStr } from './time.js';
import { fetchJson } from './net.js';

export const NOTION_VERSION = '2026-03-11';
const MAX_PAGES = 5; // × 100 results
const MAX_TODOS = 300;

/** Accepts a database URL, a 32-hex id or a dashed UUID; returns a dashed UUID or null. */
export function parseNotionId(input) {
  const s = String(input || '').trim();
  const m = s.match(/[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}/gi);
  if (!m) return null;
  // In URLs like notion.so/Workspace/Title-<id>?v=<viewId>, the database id comes first.
  const hex = m[0].replace(/-/g, '').toLowerCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function headers(token) {
  return {
    Authorization: `Bearer ${token}`,
    'Notion-Version': NOTION_VERSION,
    'Content-Type': 'application/json',
  };
}

async function api(token, path, body) {
  return fetchJson(`${HOSTS.notion}/v1/${path}`, body
    ? { method: 'POST', headers: headers(token), body: JSON.stringify(body) }
    : { method: 'GET', headers: headers(token) });
}

/** Resolve the data source id (and its property schema) for the configured database. */
async function resolveSource(token, databaseId) {
  let dataSourceId = null;
  try {
    const db = await api(token, `databases/${databaseId}`);
    const list = Array.isArray(db?.data_sources) ? db.data_sources : [];
    dataSourceId = typeof list[0]?.id === 'string' ? list[0].id : null;
  } catch (e) {
    if (e.status !== 404 && e.status !== 400) throw e;
  }
  // The user may have pasted a data source id directly.
  const ds = await api(token, `data_sources/${dataSourceId || databaseId}`);
  if (ds?.object !== 'data_source' || typeof ds.id !== 'string') {
    throw new Error('Notion: could not find that database. Is it shared with the integration?');
  }
  const propTypes = {};
  for (const [name, p] of Object.entries(ds.properties || {})) {
    if (p && typeof p.type === 'string') propTypes[name] = p.type;
  }
  // Option names of status/select properties, shown in Options to help pick "done" values.
  const propOptions = {};
  for (const [name, p] of Object.entries(ds.properties || {})) {
    const opts = p?.[p?.type]?.options;
    if ((p?.type === 'status' || p?.type === 'select') && Array.isArray(opts)) {
      propOptions[name] = opts.map((o) => String(o?.name || '').slice(0, 60)).filter(Boolean).slice(0, 50);
    }
  }
  return { databaseId, dataSourceId: ds.id, propTypes, propOptions, resolvedAt: Date.now() };
}

function doneList(props) {
  return String(props.doneValues || 'Done').split(',').map((v) => v.trim()).filter(Boolean);
}

export function buildFilter(props, propTypes) {
  const type = propTypes[props.status];
  const done = doneList(props);
  if (type === 'checkbox') return { property: props.status, checkbox: { equals: false } };
  if (type === 'status' || type === 'select') {
    const parts = done.map((v) => ({ property: props.status, [type]: { does_not_equal: v } }));
    return parts.length === 1 ? parts[0] : { and: parts };
  }
  return undefined;
}

export async function fetchNotion(config, meta) {
  const token = String(config.notionToken || '').trim();
  const databaseId = parseNotionId(config.notionDatabase);
  if (!token || !databaseId) throw new Error('Notion token or database not configured');

  let source = meta && meta.databaseId === databaseId && meta.dataSourceId && meta.propOptions
    && Date.now() - (meta.resolvedAt || 0) < 86400000
    ? meta : null;
  if (!source) source = await resolveSource(token, databaseId);

  const props = config.notionProps;
  if (props.status && !(props.status in source.propTypes)) {
    // Schema may have changed since it was cached; re-resolve once.
    if (source === meta) source = await resolveSource(token, databaseId);
    if (!(props.status in source.propTypes)) throw new Error(`Notion: property "${props.status}" not found in the database`);
  }

  const filter = buildFilter(props, source.propTypes);
  const pages = [];
  let cursor;
  for (let i = 0; i < MAX_PAGES; i++) {
    const body = { page_size: 100 };
    if (filter) body.filter = filter;
    if (cursor) body.start_cursor = cursor;
    const res = await api(token, `data_sources/${source.dataSourceId}/query`, body);
    if (!Array.isArray(res?.results)) throw new Error('Notion: unexpected query response');
    pages.push(...res.results);
    if (!res.has_more || typeof res.next_cursor !== 'string') break;
    cursor = res.next_cursor;
  }
  return { todos: normaliseTodos(pages, props, source.propOptions), meta: source };
}

// ── normalisation ─────────────────────────────────────────────────────────

const plain = (arr) => (Array.isArray(arr) ? arr.map((t) => (typeof t?.plain_text === 'string' ? t.plain_text : '')).join('') : '');
const clean = (s, max = 200) => String(s || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

function propText(p) {
  if (!p || typeof p !== 'object') return '';
  switch (p.type) {
    case 'title': return plain(p.title);
    case 'rich_text': return plain(p.rich_text);
    case 'select': return p.select?.name || '';
    case 'status': return p.status?.name || '';
    case 'multi_select': return Array.isArray(p.multi_select) ? p.multi_select.map((o) => o?.name || '').join(', ') : '';
    case 'formula': return p.formula?.type === 'string' ? p.formula.string || '' : '';
    default: return '';
  }
}

function propNumber(p) {
  if (!p) return null;
  let v = null;
  if (p.type === 'number') v = p.number;
  else if (p.type === 'formula' && p.formula?.type === 'number') v = p.formula.number;
  else if (p.type === 'rich_text') v = parseFloat(plain(p.rich_text));
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : null;
}

function propDate(p) {
  let start = null;
  if (p?.type === 'date') start = p.date?.start;
  else if (p?.type === 'formula' && p.formula?.type === 'date') start = p.formula.date?.start;
  if (typeof start !== 'string') return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(start)) return start;
  const t = Date.parse(start);
  return Number.isFinite(t) ? dateStr(t) : null;
}

function safeNotionUrl(u) {
  try {
    const url = new URL(u);
    if (url.protocol !== 'https:') return null;
    if (!/(^|\.)notion\.(so|site|com)$/.test(url.hostname)) return null;
    return url.href;
  } catch {
    return null;
  }
}

const PRIORITY_WORDS = [
  [0, /^(p0|urgent|critical|highest|asap)\b/],
  [1, /^(p1|high)\b/],
  [2, /^(p2|med(ium)?|normal)\b/],
  [3, /^(p3|low)\b/],
  [4, /^(p4|lowest|someday|whenever)\b/],
];

/**
 * Rank a priority value: 0 = most important. Recognised words (High, Medium, P1…) win;
 * otherwise the option's position in the Notion schema; numbers rank as-is (1 before 2).
 * Returns null when the to-do has no priority.
 */
export function priorityRank(value, options = []) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const v = String(value || '').trim().toLowerCase();
  if (!v) return null;
  for (const [rank, re] of PRIORITY_WORDS) if (re.test(v)) return rank;
  const idx = options.findIndex((o) => o.toLowerCase() === v);
  return idx >= 0 ? idx : PRIORITY_WORDS.length;
}

function propPriority(p, options) {
  if (!p) return null;
  const label = p.type === 'number' ? (p.number == null ? '' : String(p.number)) : clean(propText(p), 30);
  const rank = priorityRank(p.type === 'number' ? p.number : label, options);
  return rank == null ? null : { label, rank };
}

export function normaliseTodos(pages, props, propOptions = {}) {
  const done = new Set(doneList(props).map((v) => v.toLowerCase()));
  const out = [];
  for (const page of pages) {
    if (!page || page.object !== 'page' || typeof page.id !== 'string') continue;
    if (page.in_trash || page.archived) continue;
    const P = page.properties || {};
    let titleProp = P[props.title];
    if (!titleProp || titleProp.type !== 'title') titleProp = Object.values(P).find((p) => p?.type === 'title');
    const statusProp = P[props.status];
    if (statusProp?.type === 'checkbox' ? statusProp.checkbox === true : done.has(propText(statusProp).toLowerCase())) continue;
    out.push({
      id: page.id.replace(/[^0-9a-f-]/gi, '').slice(0, 40),
      url: safeNotionUrl(page.url),
      title: clean(propText(titleProp)) || 'Untitled',
      status: clean(propText(statusProp), 40),
      due: propDate(P[props.due]),
      estimate: propNumber(P[props.estimate]),
      related: clean(propText(P[props.related]), 120),
      priority: props.priority ? propPriority(P[props.priority], propOptions[props.priority] || []) : null,
    });
    if (out.length >= MAX_TODOS) break;
  }
  return out;
}
