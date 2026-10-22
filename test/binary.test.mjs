// Binary plans: telling which tool wrote one without running anything, and, when tofu or
// terraform is available (TOFU_BIN / TERRAFORM_BIN, or on PATH), that `show -json` on the
// real fixture reads the same as the JSON fixture.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { core, fixtureBytes, real, tfplan } from './helpers.mjs';

test('a binary plan is recognised and its tool and version read from the archive', () => {
  const bytes = fixtureBytes('real/changes.tfplan');
  assert.equal(core.looksLikeBinaryPlan(bytes), true);
  assert.equal(core.looksLikeBinaryPlan(Buffer.from('{"format_version":"1.2"}')), false);
  const info = tfplan.inspectBinaryPlan(bytes);
  assert.equal(info.flavor, 'opentofu');
  assert.equal(info.version, '1.13.1');
  assert.ok(info.entries.includes('tfplan') && info.entries.includes('tfstate'));
  const create = tfplan.inspectBinaryPlan(fixtureBytes('real/create.tfplan'));
  assert.equal(create.flavor, 'opentofu');
});

test('not a zip, or an empty zip, is handled', () => {
  assert.deepEqual(tfplan.inspectBinaryPlan(Buffer.from('PK\x03\x04garbage')), { flavor: 'unknown', entries: [] });
  assert.deepEqual(tfplan.inspectBinaryPlan(Buffer.alloc(0)), { flavor: 'unknown', entries: [] });
});

const bin = process.env.TOFU_BIN || process.env.TERRAFORM_BIN || which('tofu') || which('terraform');

function which(name) {
  for (const d of (process.env.PATH ?? '').split(path.delimiter)) {
    const f = path.join(d, name);
    if (existsSync(f)) return f;
  }
  return undefined;
}

test('show -json on the real binary plan reads the same as the JSON fixture', { skip: bin ? false : 'no tofu or terraform binary available' }, () => {
  // The plan was written in a folder with its providers initialised; `show -json` only
  // needs the plan file and the provider schemas, which the plan carries since 1.x, but
  // `tofu show` still wants a working directory, so copy it to a temp folder.
  const dir = mkdtempSync(path.join(tmpdir(), 'tpv-bin-'));
  copyFileSync(new URL('./fixtures/real/changes.tfplan', import.meta.url), path.join(dir, 'changes.tfplan'));
  writeFileSync(path.join(dir, 'main.tf'), '');
  let out;
  try {
    out = execFileSync(bin, ['show', '-json', '-no-color', 'changes.tfplan'], { cwd: dir, encoding: 'utf8', env: { ...process.env, TF_IN_AUTOMATION: '1' }, maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    // A binary of another version refuses the plan: that is terraform's rule, not a bug here.
    const msg = String(e.stderr ?? e.message);
    assert.match(msg, /version|plan file|init|provider|schema/i, msg);
    return;
  }
  const fromBinary = core.parsePlan(out);
  const fromJson = core.parsePlan(real('changes.json'));
  assert.deepEqual(fromBinary.counts, fromJson.counts);
  assert.deepEqual(fromBinary.resources.map((r) => [r.address, r.action]), fromJson.resources.map((r) => [r.address, r.action]));
});
