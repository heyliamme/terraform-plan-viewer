// The text plan reader: the real OpenTofu output with and without colour codes, a
// Terraform 1.x plan with heredocs, nested blocks, drift and a boxed warning, CI log
// decorations, and truncated input.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { attr, byAddress, core, fixture, real } from './helpers.mjs';

test('the real OpenTofu text plan reads the same as its JSON', () => {
  const j = core.parsePlan(real('changes.json'));
  const t = core.parsePlan(real('changes.plan.txt'));
  assert.equal(t.source, 'text');
  assert.equal(t.flavor, 'opentofu');
  assert.equal(t.planLine, 'Plan: 1 to import, 6 to add, 1 to change, 7 to destroy, 1 to forget.');
  assert.deepEqual(t.unparsed, []);
  assert.deepEqual(t.notes, []);
  // The text has no no-ops: everything else matches.
  const jActions = Object.fromEntries(j.resources.filter((r) => r.action !== 'no-op').map((r) => [r.address, r.action]));
  const tActions = Object.fromEntries(t.resources.map((r) => [r.address, r.action]));
  assert.deepEqual(tActions, jActions);
  for (const tr of t.resources) {
    const jr = byAddress(j, tr.address);
    assert.deepEqual(tr.changedKeys.sort(), jr.changedKeys.sort(), `changed keys of ${tr.address}`);
    assert.deepEqual(tr.forces, jr.forces, `forced paths of ${tr.address}`);
    assert.equal(tr.previousAddress, jr.previousAddress, `moved from, ${tr.address}`);
    assert.equal(tr.importId, jr.importId, `import id, ${tr.address}`);
    assert.equal(tr.replaceOrder, jr.replaceOrder, `replace order, ${tr.address}`);
  }
  assert.deepEqual(t.outputs.map((o) => [o.name, o.action]), j.outputs.filter((o) => o.action !== 'no-op').map((o) => [o.name, o.action]));
  assert.deepEqual({ ...t.counts, noop: 0, drift: 0 }, { ...j.counts, noop: 0, drift: 0 });
  assert.deepEqual(t.diagnostics.map((d) => [d.severity, d.summary]), [['warning', 'Resource will be removed from the state'], ['warning', 'Check block assertion failed']]);
  assert.match(t.diagnostics[1].detail, /env is not staging/);
});

test('colour codes make no difference', () => {
  const plain = core.parsePlan(real('changes.plan.txt'));
  const ansi = core.parsePlan(real('changes.plan.ansi.txt'));
  assert.deepEqual(ansi.notes, ['colour codes removed']);
  const strip = (p) => ({ counts: p.counts, planLine: p.planLine, resources: p.resources.map((r) => ({ a: r.address, k: r.action, keys: r.changedKeys, attrs: JSON.stringify(r.attrs) })), outputs: p.outputs });
  assert.deepEqual(strip(ansi), strip(plain));
  for (const f of ['create', 'sensitive', 'errored']) {
    const a = core.parsePlan(real(`${f}.plan.ansi.txt`));
    const b = core.parsePlan(real(`${f}.plan.txt`));
    assert.deepEqual(strip(a), strip(b), f);
  }
});

test('`show` output reads like `plan` output', () => {
  const show = core.parsePlan(real('changes.show.txt'));
  const plan = core.parsePlan(real('changes.plan.txt'));
  assert.deepEqual(show.counts, plan.counts);
  assert.deepEqual(show.resources.map((r) => r.address), plan.resources.map((r) => r.address));
  assert.deepEqual(core.parsePlan(real('changes.show.ansi.txt')).counts, plan.counts);
});

test('jsonencode values, unknown containers, sensitive values and forget blocks', () => {
  const t = core.parsePlan(real('changes.plan.txt'));
  const config = byAddress(t, 'local_file.config');
  const content = attr(config, 'content');
  assert.equal(content.encoded, 'json');
  assert.equal(content.forcesReplacement, true);
  assert.deepEqual([attr(config, 'content.env').before, attr(config, 'content.env').after], ['staging', 'production']);
  assert.equal(attr(config, 'content.tags.team').kind, 'same');
  assert.equal(attr(config, 'content.tags.tier').after, 'api');
  assert.equal(content.hidden, 2, 'the hidden-attributes comment inside jsonencode');
  const settings = byAddress(t, 'terraform_data.settings');
  const output = attr(settings, 'output');
  assert.equal(output.afterUnknown, true);
  assert.deepEqual(output.before, { env: 'staging', features: ['a', 'b'], replicas: 2 });
  // "# (1 unchanged element hidden)" keeps its place, so "c" is the third element, as in the JSON.
  assert.equal(attr(settings, 'input.features[2]').after, 'c');
  assert.equal(attr(settings, 'input.features[1]').kind, 'same');
  assert.equal(attr(settings, 'input.features').hidden, 1);
  const forgotten = byAddress(t, 'null_resource.forgotten');
  assert.equal(forgotten.action, 'forget');
  assert.ok(forgotten.attrs.every((a) => a.kind === 'same'));
  assert.equal(attr(forgotten, 'triggers.keep').before, 'me');
  const s = core.parsePlan(real('sensitive.plan.txt'));
  const pw = byAddress(s, 'random_password.db');
  assert.equal(attr(pw, 'result').beforeSensitive, true);
  assert.equal(attr(pw, 'result').afterSensitive, true);
  assert.equal(attr(pw, 'length').forcesReplacement, true);
  assert.deepEqual(pw.forces, ['length']);
  assert.equal(s.outputs.find((o) => o.name === 'password').beforeSensitive, true);
});

test('a Terraform 1.x plan: drift, heredoc diff, nested blocks, deposed, tainted, moved, imported', () => {
  const p = core.parsePlan(fixture('handwritten/terraform-1.x.txt'));
  assert.equal(p.flavor, 'terraform');
  assert.deepEqual(p.unparsed, []);
  assert.equal(p.planLine, 'Plan: 4 to add, 3 to change, 6 to destroy.');
  // Drift section.
  assert.deepEqual(p.drift.map((d) => [d.address, d.action]), [['aws_security_group.web', 'update'], ['aws_instance.canary', 'delete']]);
  assert.equal(attr(p.drift[0], 'tags.Owner').kind, 'remove');
  // The plan.
  const web = byAddress(p, 'aws_instance.web');
  assert.equal(web.action, 'replace');
  assert.equal(web.replaceOrder, 'delete-create');
  assert.deepEqual(web.forces, ['ami']);
  assert.equal(attr(web, 'tags.CostCenter').kind, 'add');
  assert.equal(attr(web, 'tags.Environment').after, 'production');
  assert.equal(attr(web, 'tags').hidden, 1);
  const ud = attr(web, 'user_data');
  assert.equal(ud.kind, 'change');
  assert.equal(ud.before, '#!/bin/bash\necho "hello from staging" > /etc/motd\nsystemctl restart nginx\n');
  assert.equal(ud.after, '#!/bin/bash\necho "hello from production" > /etc/motd\nsystemctl restart nginx\n');
  assert.equal(attr(web, 'root_block_device').block, true);
  assert.equal(attr(web, 'root_block_device.volume_size').after, 20);
  assert.equal(attr(web, 'ebs_block_device').kind, 'add');
  assert.equal(attr(web, 'ebs_block_device.volume_type').after, 'gp3');
  const deposed = p.resources.find((r) => r.deposed);
  assert.equal(deposed.address, 'aws_instance.web');
  assert.equal(deposed.deposed, '8e4f2a1c');
  assert.equal(deposed.action, 'delete');
  const policy = attr(byAddress(p, 'aws_iam_role_policy.app'), 'policy');
  assert.equal(policy.encoded, 'json');
  assert.equal(attr(byAddress(p, 'aws_iam_role_policy.app'), 'policy.Statement[0].Action[1]').after, 's3:PutObject');
  const logs = byAddress(p, 'aws_s3_bucket.logs');
  assert.equal(logs.action, 'import');
  assert.equal(logs.importId, 'my-logs-bucket');
  const assets = byAddress(p, 'aws_s3_bucket.assets');
  assert.equal(assets.action, 'update');
  assert.equal(assets.importId, 'my-assets-bucket');
  const db = byAddress(p, 'module.db.aws_db_instance.main');
  assert.equal(db.action, 'replace');
  assert.equal(db.reason, 'replace_because_tainted');
  assert.equal(db.module, 'module.db');
  assert.equal(attr(db, 'password').beforeSensitive, true);
  assert.equal(byAddress(p, 'module.db.aws_db_subnet_group.old').reason, 'delete_because_no_resource_config');
  assert.equal(byAddress(p, 'module.net.aws_subnet.private[1]').reason, 'delete_because_count_index');
  assert.equal(byAddress(p, 'module.net.aws_subnet.private[1]').index, 1);
  const moved = byAddress(p, 'aws_route53_record.app_v2');
  assert.equal(moved.action, 'move');
  assert.equal(moved.previousAddress, 'aws_route53_record.app');
  const sg = byAddress(p, 'aws_security_group.web');
  assert.equal(sg.action, 'update');
  assert.equal(sg.previousAddress, 'aws_security_group.legacy');
  const worker = byAddress(p, 'aws_lambda_function.worker');
  assert.equal(worker.reason, 'replace_by_request');
  assert.equal(worker.replaceOrder, 'create-delete');
  assert.equal(attr(worker, 'environment.variables.LOG_LEVEL').after, 'debug');
  const ami = byAddress(p, 'data.aws_ami.latest');
  assert.equal(ami.action, 'read');
  assert.equal(ami.mode, 'data');
  assert.equal(ami.reason, 'read_because_config_unknown');
  assert.equal(attr(ami, 'filter.values[0]').after, 'ubuntu/images/hvm-ssd/*');
  const canary = byAddress(p, 'aws_instance.canary');
  assert.equal(attr(canary, 'user_data').after, '#!/bin/bash\necho canary\n');
  // Outputs, including a list diff and a sensitive one.
  assert.deepEqual(p.outputs.map((o) => [o.name, o.action]), [['canary_ip', 'create'], ['db_password', 'update'], ['old_address', 'delete'], ['subnets', 'update'], ['web_address', 'update']]);
  assert.deepEqual(p.outputs.find((o) => o.name === 'subnets').before, ['subnet-bbb', 'subnet-aaa']);
  assert.deepEqual(p.outputs.find((o) => o.name === 'subnets').after, ['subnet-aaa']);
  assert.equal(p.outputs.find((o) => o.name === 'web_address').afterUnknown, true);
  // The boxed warning.
  assert.deepEqual(p.diagnostics.map((d) => [d.severity, d.summary]), [['warning', 'Deprecated attribute']]);
  assert.match(p.diagnostics[0].detail, /on main\.tf line 42/);
  // 1 create + 3 replace = "4 to add"; 3 delete + 3 replace = "6 to destroy": the plan line agrees.
  assert.deepEqual(p.counts, { create: 1, update: 3, delete: 3, replace: 3, read: 1, move: 2, import: 2, forget: 0, noop: 0, drift: 2, outputs: 5 });
  assert.ok(!p.notes.some((n) => /don't agree/.test(n)), p.notes.join(' / '));
});

test('CI logs: GitHub Actions timestamps and groups', () => {
  const p = core.parsePlan(fixture('ci/github-actions.log'));
  assert.deepEqual(p.notes, ['colour codes removed', 'GitHub Actions timestamps removed', 'Azure Pipelines markers removed']);
  assert.equal(p.planLine, 'Plan: 1 to import, 6 to add, 1 to change, 7 to destroy, 1 to forget.');
  assert.deepEqual(p.counts, { ...core.parsePlan(real('changes.plan.txt')).counts });
  assert.deepEqual(p.unparsed, []);
});

test('CI logs: GitLab section markers and the shell prompt', () => {
  const p = core.parsePlan(fixture('ci/gitlab.log'));
  assert.ok(p.notes.includes('GitLab section markers removed'), p.notes.join(', '));
  assert.ok(p.notes.includes('colour codes removed'));
  assert.equal(p.counts.replace, 3);
  assert.deepEqual(p.unparsed, []);
});

test('CI logs: Atlantis-style Markdown with fences and details', () => {
  const p = core.parsePlan(fixture('ci/atlantis.md'));
  assert.ok(p.notes.includes('Markdown fences and details tags removed'), p.notes.join(', '));
  assert.equal(p.counts.create, 3);
  assert.equal(p.counts.delete, 4);
  assert.deepEqual(p.unparsed, []);
});

test('colour codes that lost their escape byte are still removed', () => {
  const text = real('changes.plan.ansi.txt').replace(/\x1b/g, '');
  const p = core.parsePlan(text);
  assert.deepEqual(p.notes, ['colour codes (without their escape byte) removed']);
  assert.equal(p.counts.replace, 3);
});

test('truncated input: what was read is kept and the cut is reported', () => {
  const full = real('changes.plan.txt');
  const cut = full.slice(0, full.indexOf('      ~ id       = "6872094199069763647"'));
  const p = core.parsePlan(cut);
  assert.ok(p.resources.length >= 8, `${p.resources.length} resources read before the cut`);
  const hook = byAddress(p, 'null_resource.hook');
  assert.ok(hook, 'the resource that was cut is still listed');
  assert.ok(hook.unparsed?.some((l) => /ends before its closing brace/.test(l)), hook.unparsed);
  assert.ok(p.notes.some((n) => /could not be read/.test(n)), p.notes.join(' / '));
  assert.equal(p.planLine, undefined);
});

test('a line that is not understood is reported, not swallowed', () => {
  const text = ['Terraform will perform the following actions:', '', '  # aws_x.y will be created', '  + resource "aws_x" "y" {', '      + name = "n"', '      + weird ===> something odd', '    }', '', 'Plan: 1 to add, 0 to change, 0 to destroy.'].join('\n');
  const p = core.parsePlan(text);
  assert.equal(p.resources.length, 1);
  assert.equal(attr(p.resources[0], 'name').after, 'n');
  assert.deepEqual(p.unparsed.map((u) => u.text), ['+ weird ===> something odd']);
  assert.equal(p.resources[0].unparsed.length, 1);
});

test('a plan line that disagrees with the resources read is flagged', () => {
  const text = ['Terraform will perform the following actions:', '', '  # aws_x.y will be created', '  + resource "aws_x" "y" {', '      + name = "n"', '    }', '', 'Plan: 3 to add, 0 to change, 0 to destroy.'].join('\n');
  const p = core.parsePlan(text);
  assert.ok(p.notes.some((n) => /don't agree/.test(n) && /add: the line says 3, 1 read/.test(n)), p.notes.join(' / '));
});

test('no changes', () => {
  const p = core.parsePlan('No changes. Your infrastructure matches the configuration.\n\nTerraform has compared your real infrastructure against your configuration and found no differences, so no changes are needed.\n');
  assert.equal(p.planLine, 'No changes. Your infrastructure matches the configuration.');
  assert.equal(core.hasChanges(p.counts), false);
  assert.deepEqual(p.notes, []);
});

test('text with nothing plan-like says so', () => {
  assert.throws(() => core.parsePlan('just some log output\nwith nothing in it\n'), /doesn't look like a plan/);
  const p = core.parsePlanText('Initializing the backend...\n\nSuccess!\n');
  assert.ok(p.notes.some((n) => /No plan was found/.test(n)));
});

test('Go-quoted strings', () => {
  assert.equal(core.unquote('"a\\"b\\\\c\\n\\t\\u00e9\\x41"').value, 'a"b\\c\n\té' + 'A');
  assert.equal(core.unquote('"unterminated'), undefined);
  assert.equal(core.unquote('"ok" rest').end, 4);
});

test('cleanLog: timestamps, markers, fences', () => {
  const c = core.cleanLog('2026-10-21T10:00:00.1234567Z \x1b[32m+\x1b[0m create\r\n##[group]x\r\n[2026-10-21T10:00:00Z] line\n```diff\n<details><summary>x</summary>\n- destroy\n</details>\n```\n');
  assert.equal(c.text, '+ create\nline\n- destroy\n');
  assert.deepEqual(c.notes, ['colour codes removed', 'GitHub Actions timestamps removed', 'timestamps removed', 'Azure Pipelines markers removed', 'Markdown fences and details tags removed']);
});
