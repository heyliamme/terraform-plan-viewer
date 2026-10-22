// Comparing two plans.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { core, real } from './helpers.mjs';

test('two runs of the same plan: no differences', () => {
  const a = core.parsePlan(real('changes.json'));
  const b = core.parsePlan(real('changes.plan.txt'));
  const c = core.comparePlans(a, b);
  assert.equal(c.counts.added + c.counts.removed + c.counts.action + c.counts.attrs, 0, JSON.stringify(c.rows.filter((r) => r.status !== 'same')));
  assert.equal(c.counts.same, 19);
});

test('a replace requested on top of the same plan shows as an action change and a new output change', () => {
  const a = core.parsePlan(real('changes.json'));
  const b = core.parsePlan(real('replace.json'));
  const c = core.comparePlans(a, b);
  const server = c.rows.find((r) => r.address === 'random_pet.server');
  assert.equal(server.status, 'action');
  assert.deepEqual([server.a.action, server.b.action], ['no-op', 'replace']);
  // The config file's content changes differently once the pet name is unknown.
  const config = c.rows.find((r) => r.address === 'local_file.config');
  assert.equal(config.status, 'attrs');
  assert.ok(config.diff.includes('content.server') || config.diff.includes('content'), config.diff);
  assert.equal(c.rows[0].status !== 'same', true, 'differences first');
});

test('resources only in one plan', () => {
  const a = core.parsePlan(real('create.json'));
  const b = core.parsePlan(real('destroy.json'));
  const c = core.comparePlans(a, b);
  assert.ok(c.counts.action > 0);
  assert.ok(c.rows.some((r) => r.status === 'added' || r.status === 'removed') || c.counts.action === 19);
  // Against a plan with nothing to do: resources it knows as no-op are "different action",
  // resources it doesn't know at all are "only in the second plan".
  const nochanges = core.parsePlan(real('nochanges.json'));
  const d = core.comparePlans(nochanges, a);
  assert.equal(d.counts.added + d.counts.action, 21);
  assert.ok(d.counts.added > 0 && d.counts.action > 0);
  // The no-changes plan still reads a data source for a check block; the first plan has no such read.
  assert.equal(d.counts.removed, 1);
  assert.equal(d.rows.find((r) => r.status === 'removed').address, 'data.local_file.cfg');
});
