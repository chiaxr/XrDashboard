import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseNotionId, buildFilter, normaliseTodos } from '../lib/notion.js';

const PROPS = { title: 'Task name', status: 'Status', doneValues: 'Done', due: 'End date', estimate: 'Estimate (min)', related: 'Related event' };
const rt = (s) => [{ plain_text: s }];
const page = (id, title, status, extra = {}) => ({
  object: 'page', id, url: `https://app.notion.com/p/${title.replace(/\W+/g, '-')}-${id.replace(/-/g, '')}`, in_trash: false,
  properties: {
    'Task name': { type: 'title', title: rt(title) },
    Status: { type: 'status', status: { name: status } },
    'End date': { type: 'date', date: extra.due ? { start: extra.due } : null },
    'Estimate (min)': { type: 'number', number: extra.estimate ?? null },
    'Related event': { type: 'rich_text', rich_text: extra.related ? rt(extra.related) : [] },
  },
});

test('database id from URLs and raw ids', () => {
  const id = '1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d';
  const dashed = '1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d';
  assert.equal(parseNotionId(`https://www.notion.so/ws/To-dos-${id}?v=ffffffffffffffffffffffffffffffff`), dashed);
  assert.equal(parseNotionId(id), dashed);
  assert.equal(parseNotionId(dashed), dashed);
  assert.equal(parseNotionId('not an id'), null);
});

test('server-side filter matches the status property type', () => {
  assert.deepEqual(buildFilter(PROPS, { Status: 'status' }), { property: 'Status', status: { does_not_equal: 'Done' } });
  assert.deepEqual(buildFilter({ ...PROPS, doneValues: 'Done, Archived' }, { Status: 'select' }),
    { and: [{ property: 'Status', select: { does_not_equal: 'Done' } }, { property: 'Status', select: { does_not_equal: 'Archived' } }] });
  assert.deepEqual(buildFilter({ ...PROPS, status: 'Done' }, { Done: 'checkbox' }), { property: 'Done', checkbox: { equals: false } });
  assert.equal(buildFilter(PROPS, {}), undefined);
});

test('normalisation: fields, done/trash filtering, datetime due in NY, URL allow-list', () => {
  const todos = normaliseTodos([
    page('11111111-1111-1111-1111-111111111111', 'CIS 5200 Finals', 'In progress', { due: '2026-12-07', estimate: 90, related: 'Review session' }),
    page('22222222-2222-2222-2222-222222222222', 'Finished thing', 'done'),
    { ...page('33333333-3333-3333-3333-333333333333', 'Trashed', 'Not started'), in_trash: true },
    page('44444444-4444-4444-4444-444444444444', 'Late night due', 'Not started', { due: '2026-11-20T02:00:00.000Z' }),
    { ...page('55555555-5555-5555-5555-555555555555', 'Bad link', 'Not started'), url: 'javascript:alert(1)' },
    { ...page('66666666-6666-6666-6666-666666666666', 'Old domain', 'Not started'), url: 'https://www.notion.so/Old-66666666666666666666666666666666' },
    { ...page('77777777-7777-7777-7777-777777777777', 'Lookalike', 'Not started'), url: 'https://notion.com.evil.example/p/x' },
  ], PROPS);
  assert.deepEqual(todos.map((t) => t.title), ['CIS 5200 Finals', 'Late night due', 'Bad link', 'Old domain', 'Lookalike']);
  const [a, b, c, d, e] = todos;
  assert.equal(a.due, '2026-12-07');
  assert.equal(a.estimate, 90);
  assert.equal(a.related, 'Review session');
  assert.match(a.url, /^https:\/\/app\.notion\.com\/p\//);
  assert.equal(b.due, '2026-11-19', '02:00Z is 21:00 the previous evening in New York');
  assert.equal(c.url, null);
  assert.match(d.url, /^https:\/\/www\.notion\.so\//);
  assert.equal(e.url, null);
});

test('priority ranking: words first, then schema order, numbers as-is', async () => {
  const { priorityRank } = await import('../lib/notion.js');
  const opts = ['High', 'Medium', 'Low'];
  assert.deepEqual(['High', 'medium', 'Low', 'P0', 'p2 - soon'].map((v) => priorityRank(v, opts)), [1, 2, 3, 0, 2]);
  assert.equal(priorityRank('Must', ['Must', 'Should', 'Could']), 0);
  assert.equal(priorityRank('Could', ['Must', 'Should', 'Could']), 2);
  assert.equal(priorityRank('', opts), null);
  assert.equal(priorityRank(2), 2);
  const [t] = normaliseTodos([{
    ...page('88888888-8888-8888-8888-888888888888', 'Prioritised', 'Not started'),
    properties: { ...page('88888888-8888-8888-8888-888888888888', 'Prioritised', 'Not started').properties,
      Priority: { type: 'select', select: { name: 'High' } } },
  }], { ...PROPS, priority: 'Priority' }, { Priority: opts });
  assert.deepEqual(t.priority, { label: 'High', rank: 1 });
  const [u] = normaliseTodos([page('99999999-9999-9999-9999-999999999999', 'No priority', 'Not started')], { ...PROPS, priority: 'Priority' });
  assert.equal(u.priority, null);
});
