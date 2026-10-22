// A plan the size of a real large one must open fast: 5,000+ resource changes, ~20 MB.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { core, model } from './helpers.mjs';

const file = path.join(tmpdir(), 'terraform-plan-viewer-perf.json');
const script = new URL('../scripts/perf-plan.mjs', import.meta.url).pathname;

test('a 20 MB plan with 5,200 resource changes reads in under 2 seconds', () => {
  if (!existsSync(file) || statSync(file).size < 15 * 1024 * 1024) execFileSync(process.execPath, [script, file, '5200', '20'], { stdio: 'ignore' });
  const text = readFileSync(file, 'utf8');
  assert.ok(text.length > 19 * 1024 * 1024, `${(text.length / 1024 / 1024).toFixed(1)} MB`);
  const t0 = performance.now();
  const plan = core.parsePlan(text);
  const parse = performance.now() - t0;
  assert.equal(plan.resources.length, 5200);
  const t1 = performance.now();
  const rows = plan.resources.map((r, i) => ({ i, address: r.address, module: r.module, mode: r.mode, type: r.type, name: r.name, action: r.action, forces: r.forces, keys: r.changedKeys, n: r.n }));
  const groups = model.groupRows(rows, true);
  const filtered = rows.filter((r) => model.rowMatches(r, { actions: {}, query: 'tags', type: '', destructiveOnly: false, showUnchanged: false }));
  const view = performance.now() - t1;
  const t2 = performance.now();
  const md = core.toMarkdown(plan, { title: 'perf' });
  const markdown = performance.now() - t2;
  console.log(`  perf: parse ${parse.toFixed(0)} ms, group+filter ${view.toFixed(0)} ms (${groups.length} groups, ${filtered.length} matches), markdown ${markdown.toFixed(0)} ms (${(md.length / 1024).toFixed(0)} KB), ${(text.length / 1024 / 1024).toFixed(1)} MB`);
  assert.ok(parse < 2000, `parse took ${parse.toFixed(0)} ms`);
  assert.ok(parse + view < 2000, `parse and grouping took ${(parse + view).toFixed(0)} ms`);
  assert.ok(plan.counts.replace > 0 && plan.counts.delete > 0);
});
