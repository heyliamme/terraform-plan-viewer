// The view's own helpers: grouping, filtering, line diffs.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { model } from './helpers.mjs';

const row = (i, address, action, extra = {}) => {
  const m = /^((?:module\.[^.]+\.)*)/.exec(address)[1].replace(/\.$/, '');
  return { i, address, module: m, mode: 'managed', type: address.replace(m ? m + '.' : '', '').split('.')[0], name: '', action, forces: [], keys: [], n: { add: 0, change: 0, remove: 0, same: 0 }, ...extra };
};

test('groups by module, root first, destructive first inside', () => {
  const rows = [row(0, 'module.b.aws_x.y', 'create'), row(1, 'aws_a.z', 'update'), row(2, 'aws_a.b', 'delete'), row(3, 'module.a.aws_x.y', 'replace'), row(4, 'aws_a.c', 'replace'), row(5, 'aws_a.d[10]', 'create'), row(6, 'aws_a.d[2]', 'create')];
  const g = model.groupRows(rows, true);
  assert.deepEqual(g.map((x) => x.module), ['', 'module.a', 'module.b']);
  assert.deepEqual(g[0].items, [2, 4, 6, 5, 1], 'delete, replace, create (numeric order), update');
  assert.equal(g[0].counts.replace, 1);
  const byAddress = model.groupRows(rows, false);
  assert.deepEqual(byAddress[0].items, [2, 4, 6, 5, 1].sort((a, b) => rows[a].address.localeCompare(rows[b].address, undefined, { numeric: true })));
});

test('filters: actions, destructive only, type, query over address, keys and reason', () => {
  const base = { actions: {}, query: '', type: '', destructiveOnly: false, showUnchanged: false };
  const r = row(0, 'module.net.aws_subnet.private[1]', 'delete', { keys: ['cidr_block'], reason: 'delete_because_count_index', prev: 'aws_subnet.old' });
  assert.equal(model.rowMatches(r, base), true);
  assert.equal(model.rowMatches(r, { ...base, actions: { delete: false } }), false);
  assert.equal(model.rowMatches(r, { ...base, destructiveOnly: true }), true);
  assert.equal(model.rowMatches(row(1, 'aws_x.y', 'create'), { ...base, destructiveOnly: true }), false);
  assert.equal(model.rowMatches(r, { ...base, type: 'aws_subnet' }), true);
  assert.equal(model.rowMatches(r, { ...base, type: 'aws_vpc' }), false);
  assert.equal(model.rowMatches(r, { ...base, query: 'private cidr' }), true);
  assert.equal(model.rowMatches(r, { ...base, query: 'count_index' }), true);
  assert.equal(model.rowMatches(r, { ...base, query: 'subnet.old' }), true);
  assert.equal(model.rowMatches(r, { ...base, query: 'nothing-here' }), false);
  assert.equal(model.rowMatches(row(2, 'aws_x.y', 'no-op'), base), false);
  assert.equal(model.rowMatches(row(2, 'aws_x.y', 'no-op'), { ...base, showUnchanged: true }), true);
});

test('line diff keeps the common lines and marks the middle', () => {
  assert.deepEqual(model.lineDiff('a\nb\nc\n', 'a\nx\nc\n'), [{ mark: ' ', text: 'a' }, { mark: '-', text: 'b' }, { mark: '+', text: 'x' }, { mark: ' ', text: 'c' }]);
  assert.deepEqual(model.lineDiff(undefined, 'a\nb'), [{ mark: '+', text: 'a' }, { mark: '+', text: 'b' }]);
  assert.deepEqual(model.lineDiff('a', undefined), [{ mark: '-', text: 'a' }]);
});

test('types, counts and text', () => {
  const rows = [row(0, 'aws_a.x', 'create'), row(1, 'aws_a.y', 'delete'), row(2, 'aws_b.z', 'update'), row(3, 'aws_c.n', 'no-op')];
  assert.deepEqual(model.typesOf(rows), [{ type: 'aws_a', n: 2 }, { type: 'aws_b', n: 1 }]);
  assert.equal(model.scalarText('x'.repeat(200), 20), '"xxxxxxxxxxxxxxxxxx…');
  assert.equal(model.scalarText(null), 'null');
  assert.equal(model.reasonText('replace_because_tainted'), 'tainted');
  assert.equal(model.reasonText('something_new'), 'something new');
  assert.equal(model.changedCount({ kind: 'change', children: [{ kind: 'same' }, { kind: 'add' }, { kind: 'change', children: [{ kind: 'change' }, { kind: 'remove' }] }] }), 3);
  assert.equal(model.esc('<a href="x">&'), '&lt;a href=&quot;x&quot;&gt;&amp;');
});
