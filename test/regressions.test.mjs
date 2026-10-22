// Cases found in review: each one read wrong before it was fixed.
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { test } from 'node:test';
import { attr, byAddress, core, fixture, model, planDoc, rc, real, tfplan } from './helpers.mjs';

const json = (resources, extra) => core.parsePlan(JSON.stringify(planDoc(resources, extra)));

test('a heredoc that ends `EOT -> null` closes there, and the rest of the plan is read', () => {
  const text = [
    'OpenTofu will perform the following actions:',
    '',
    '  # aws_instance.old will be destroyed',
    '  - resource "aws_instance" "old" {',
    '      - ami       = "ami-1" -> null',
    '      - user_data = <<-EOT',
    '            #!/bin/bash',
    '            echo hi',
    '        EOT -> null',
    '    }',
    '',
    '  # aws_instance.new will be created',
    '  + resource "aws_instance" "new" {',
    '      + ami       = "ami-2"',
    '      + user_data = <<-EOT',
    '            #!/bin/bash',
    '        EOT',
    '      + tags      = (known after apply)',
    '    }',
    '',
    '  # aws_instance.web will be updated in-place',
    '  ~ resource "aws_instance" "web" {',
    '      ~ user_data = <<-EOT',
    '            #!/bin/bash',
    '        EOT -> (known after apply) # forces replacement',
    '    }',
    '',
    'Plan: 1 to add, 1 to change, 1 to destroy.',
  ].join('\n');
  const p = core.parsePlan(text);
  assert.deepEqual(p.resources.map((r) => r.address), ['aws_instance.old', 'aws_instance.new', 'aws_instance.web']);
  assert.deepEqual(p.unparsed, []);
  assert.equal(p.planLine, 'Plan: 1 to add, 1 to change, 1 to destroy.');
  const old = attr(byAddress(p, 'aws_instance.old'), 'user_data');
  assert.equal(old.kind, 'remove');
  assert.equal(old.before, '#!/bin/bash\necho hi\n');
  assert.equal(old.after, undefined);
  const web = attr(byAddress(p, 'aws_instance.web'), 'user_data');
  assert.equal(web.kind, 'change');
  assert.equal(web.afterUnknown, true);
  assert.equal(web.after, undefined);
  assert.equal(web.forcesReplacement, true);
  assert.equal(byAddress(p, 'aws_instance.new').changedKeys.includes('tags'), true);
});

test('`will be replaced due to changes in replace_triggered_by` is a header with its reason', () => {
  const text = [
    'Terraform will perform the following actions:',
    '',
    '  # module.app.aws_instance.web[0] will be replaced due to changes in replace_triggered_by',
    '-/+ resource "aws_instance" "web" {',
    '      ~ id = "i-1" -> (known after apply)',
    '    }',
    '',
    '  # module.app.aws_instance.web[1] will be replaced due to changes in replace_triggered_by',
    '-/+ resource "aws_instance" "web" {',
    '      ~ id = "i-2" -> (known after apply)',
    '    }',
    '',
    'Plan: 2 to add, 0 to change, 2 to destroy.',
  ].join('\n');
  const p = core.parsePlan(text);
  assert.deepEqual(p.resources.map((r) => [r.address, r.module, r.action, r.reason]), [
    ['module.app.aws_instance.web[0]', 'module.app', 'replace', 'replace_by_triggers'],
    ['module.app.aws_instance.web[1]', 'module.app', 'replace', 'replace_by_triggers'],
  ]);
  assert.deepEqual(p.notes, []);
});

test('a container replacing null keeps its sensitive parts masked, in the view and in Markdown', () => {
  const p = json([
    rc('t.a', ['update'], { before: { config: null }, after: { config: { user: 'admin', password: 'hunter2' } }, after_sensitive: { config: { password: true } } }),
    rc('t.b', ['update'], { before: { config: { password: 'oldsecret' } }, after: { config: null }, before_sensitive: { config: { password: true } } }),
    rc('t.c', ['update'], { before: { l: null }, after: { l: [{ k: 'v', secret: 's3cr3t' }] }, after_sensitive: { l: [{ secret: true }] } }),
  ]);
  for (const r of p.resources) {
    const masked = JSON.stringify(core.maskAttrs(r.attrs));
    for (const secret of ['hunter2', 'oldsecret', 's3cr3t']) assert.ok(!masked.includes(secret), `${r.address}: ${masked}`);
  }
  const md = core.toMarkdown(p, { title: 't' });
  for (const secret of ['hunter2', 'oldsecret', 's3cr3t']) assert.ok(!md.includes(secret), md);
});

test('a container keeps no copy of a masked child', () => {
  const p = json([
    rc('t.a', ['update'], {
      before: { tags: { k: 'OLDTAG', o: 'x' }, list: ['s1', 'x'] },
      after: { tags: { k: 'NEWTAG', o: 'x' }, list: ['s2', 'x'] },
      before_sensitive: { tags: { k: true }, list: [true, false] },
      after_sensitive: { tags: { k: true }, list: [true, false] },
    }),
  ]);
  const r = p.resources[0];
  const masked = JSON.stringify(core.maskAttrs(r.attrs));
  for (const secret of ['OLDTAG', 'NEWTAG', 's1', 's2']) assert.ok(!masked.includes(`"${secret}"`), masked);
  // Revealed one by one, the value comes back.
  const shown = JSON.stringify(core.maskAttrs(r.attrs, new Set(['tags.k'])));
  assert.ok(shown.includes('NEWTAG') && !shown.includes('"s2"'), shown);
});

test('a JSON string rewritten with other key order or spacing is still a change', () => {
  const p = json([
    rc('local_file.n', ['delete', 'create'], { before: { content: '{"a":1,"b":2}', id: 'x' }, after: { content: '{\n  "b": 2,\n  "a": 1\n}' }, after_unknown: { id: true }, replace_paths: [['content']] }),
    rc('local_file.m', ['update'], { before: { content: '[1, 2]' }, after: { content: '[1,2]' } }),
  ]);
  const n = byAddress(p, 'local_file.n');
  assert.equal(attr(n, 'content').kind, 'change');
  assert.ok(n.changedKeys.includes('content'));
  const md = core.toMarkdown(p, { title: 't' });
  assert.ok(md.includes('| `content` (forces replacement) |'), md);
  assert.equal(attr(byAddress(p, 'local_file.m'), 'content').kind, 'change');
  assert.ok(!md.includes('_No attribute changes shown._'), md);
});

test('a deposed object is its own row when comparing', () => {
  const web = (actions, extra = {}) => rc('aws_instance.web', actions, { before: { a: 1 }, after: actions.includes('delete') ? null : { a: 2 } }, extra);
  const a = json([web(['update']), web(['delete'], { deposed: 'abcd1234' })]);
  const b = json([web(['update'])]);
  const c = core.comparePlans(a, b);
  const rows = Object.fromEntries(c.rows.map((r) => [r.address, r.status]));
  assert.deepEqual(rows, { 'aws_instance.web (deposed abcd1234)': 'removed', 'aws_instance.web': 'same' });
});

test('list elements each have their own path, removed ones too', () => {
  const p = json([rc('t.a', ['update'], { before: { l: ['r0', 'r1', 'X'] }, after: { l: ['X', 'a1'] } })]);
  const kids = attr(p.resources[0], 'l').children;
  const paths = kids.map((k) => k.path);
  assert.equal(new Set(paths).size, paths.length, paths.join(' '));
  assert.deepEqual(kids.map((k) => [k.key, k.kind]), [['[0]', 'remove'], ['[1]', 'remove'], ['[0]', 'same'], ['[1]', 'add']]);
  const q = json([rc('t.a', ['update'], { before: { l: ['r0', 'DIFFERENT', 'X'] }, after: { l: ['X', 'a1'] } })]);
  assert.equal(core.comparePlans(p, q).rows[0].status, 'attrs');
});

test('repeated nested blocks in a text plan get indexed paths', () => {
  const plan = (port) =>
    core.parsePlan(
      [
        'Terraform will perform the following actions:',
        '',
        '  # aws_security_group.sg will be updated in-place',
        '  ~ resource "aws_security_group" "sg" {',
        '        id = "sg-1"',
        '',
        '      - ingress {',
        `          - from_port = ${port} -> null`,
        '        }',
        '      + ingress {',
        '          + from_port = 443',
        '        }',
        '    }',
        '',
        'Plan: 0 to add, 1 to change, 0 to destroy.',
      ].join('\n'),
    );
  const a = plan(80);
  const r = a.resources[0];
  assert.deepEqual(r.changedKeys, ['ingress']);
  assert.deepEqual(core.changedLeaves(r.attrs).map((x) => x.path), ['ingress[0].from_port', 'ingress[1].from_port']);
  assert.equal(core.comparePlans(a, plan(22)).rows[0].status, 'attrs');
});

test('a ``` line in a multi-line value does not close the Markdown diff block', () => {
  const p = json([rc('local_file.readme', ['update'], { before: { content: '# Title\n```sh\nmake\n```\nold\n' }, after: { content: '# Title\n```sh\nmake\n```\nnew\n' } })]);
  const md = core.toMarkdown(p, { title: 't' });
  const open = md.indexOf('````diff');
  assert.ok(open > 0, md);
  const close = md.indexOf('\n````\n', open);
  assert.ok(close > md.indexOf('+new', open), md);
});

test('an address cannot inject HTML into the Markdown summary', () => {
  const p = json([
    rc('null_resource.a["<!--"]', ['create'], { after: { x: 1 } }),
    rc('null_resource.z', ['update'], { before: { x: 1 }, after: { x: 2 } }),
  ]);
  const md = core.toMarkdown(p, { title: 't' });
  assert.ok(!md.includes('<!--'), md);
  assert.ok(md.includes('<summary>+ <code>null_resource.a[&quot;&lt;!--&quot;]</code> — create</summary>'), md);
});

test('integers past 2^53 keep every digit, in JSON and in text', () => {
  const text = JSON.stringify(planDoc([rc('t.a', ['update'], { before: { n: 1 }, after: { n: 2 } })])).replace('"n":1', '"n":9007199254740993').replace('"n":2', '"n":9007199254740992');
  const p = core.parsePlan(text);
  const n = attr(p.resources[0], 'n');
  assert.equal(n.kind, 'change');
  assert.deepEqual([n.before, n.after], ['9007199254740993', '9007199254740992']);
  const t = core.parsePlan(['Terraform will perform the following actions:', '', '  # t.a will be updated in-place', '  ~ resource "t" "a" {', '      ~ n = 9007199254740993 -> 9007199254740992', '    }', '', 'Plan: 0 to add, 1 to change, 0 to destroy.'].join('\n'));
  assert.equal(attr(t.resources[0], 'n').kind, 'change');
  assert.equal(attr(t.resources[0], 'n').before, '9007199254740993');
});

test('a plan file saved as UTF-16 (Windows PowerShell) reads', () => {
  const text = real('changes.json');
  const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
  assert.equal(core.parsePlan(core.decodeText(le)).resources.length, core.parsePlan(text).resources.length);
  const be = Buffer.from(le);
  be.swap16();
  assert.equal(core.decodeText(be), text);
});

test('a CI log whose plan starts after megabytes of other output is still a plan', () => {
  const log = fixture('ci/github-actions.log');
  const noise = Array.from({ length: 60000 }, (_, i) => `2026-10-21T10:00:00.0000000Z npm notice step ${i} of the build output`).join('\n');
  const p = core.parsePlan(`${noise}\n${log}`);
  assert.equal(p.resources.length, 19);
});

test('a closer followed by a long run of spaces reads in linear time', () => {
  const line = `        }${' '.repeat(20000)}x`;
  const text = ['  # a.b will be created', '  + resource "a" "b" {', '      + x = [', line, `      + y = ${'1'.repeat(20000)}x`, '    }', '', 'Plan: 1 to add, 0 to change, 0 to destroy.'].join('\n');
  const t0 = performance.now();
  core.parsePlan(text, 'text');
  const ms = performance.now() - t0;
  assert.ok(ms < 1000, `${ms.toFixed(0)} ms`);
});

test('a zip entry that inflates far past its declared size is not inflated', () => {
  const data = deflateRawSync(Buffer.alloc(200 * 1024 * 1024));
  const name = Buffer.from('tfplan');
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(1, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(1, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(0, 42);
  const cdOffset = local.length + name.length + data.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length + name.length, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  const zip = Buffer.concat([local, name, data, central, name, eocd]);
  const t0 = performance.now();
  const info = tfplan.inspectBinaryPlan(zip);
  assert.deepEqual(info.entries, ['tfplan']);
  assert.equal(info.flavor, 'unknown');
  assert.ok(performance.now() - t0 < 3000);
});

test('lost colour codes are removed, but `[5m]` in a PromQL value is kept', () => {
  const text = [
    'Terraform will perform the following actions:',
    '',
    '[1m  # grafana_rule.r[0m will be created',
    '[0m  [32m+[0m[0m resource "grafana_rule" "r" {',
    '      [32m+[0m[0m expr1 = "rate(http_requests_total[5m])"',
    '      [32m+[0m[0m expr2 = "rate(errors_total[1m])"',
    '      [32m+[0m[0m expr3 = "avg_over_time(up[10m]) [0m"',
    '    }',
    '',
    '[1mPlan:[0m 1 to add, 0 to change, 0 to destroy.',
  ].join('\n');
  const p = core.parsePlan(text);
  const r = byAddress(p, 'grafana_rule.r');
  assert.equal(attr(r, 'expr1').after, 'rate(http_requests_total[5m])');
  assert.equal(attr(r, 'expr2').after, 'rate(errors_total[1m])');
  assert.equal(attr(r, 'expr3').after, 'avg_over_time(up[10m]) [0m', 'inside a string nothing is removed');
  // Without the colour codes around them, values are never touched.
  const plain = ['Terraform will perform the following actions:', '', '  # a.b will be created', '  + resource "a" "b" {', '      + e1 = "x[5m]"', '      + e2 = "x[1m]"', '      + e3 = "x[10m]"', '      + e4 = "y[0m"', '    }'].join('\n');
  const q = byAddress(core.parsePlan(plain), 'a.b');
  assert.deepEqual(['e1', 'e2', 'e3', 'e4'].map((k) => attr(q, k).after), ['x[5m]', 'x[1m]', 'x[10m]', 'y[0m']);
});

test('a heredoc holding Markdown or HTML keeps its fences and tags', () => {
  const text = [
    '```diff',
    '<details><summary>Plan</summary>',
    '',
    'Terraform will perform the following actions:',
    '',
    '  # local_file.readme will be created',
    '  + resource "local_file" "readme" {',
    '      + content = <<-EOT',
    '            # Title',
    '            ```bash',
    '            make build',
    '            ```',
    '            <details>x</details>',
    '        EOT',
    '    }',
    '',
    'Plan: 1 to add, 0 to change, 0 to destroy.',
    '</details>',
    '```',
  ].join('\n');
  const p = core.parsePlan(text);
  assert.equal(attr(byAddress(p, 'local_file.readme'), 'content').after, '# Title\n```bash\nmake build\n```\n<details>x</details>\n');
  assert.ok(p.notes.some((n) => /Markdown/.test(n)));
});

test('jsonencode( … ) -> (known after apply) keeps the old JSON string, as the JSON reading does', () => {
  const j = core.parsePlan(real('replace.json'));
  const t = core.parsePlan(real('replace.plan.txt'));
  const tc = attr(byAddress(t, 'local_file.config'), 'content');
  const jc = attr(byAddress(j, 'local_file.config'), 'content');
  assert.equal(tc.before, jc.before);
  assert.equal(tc.afterUnknown, true);
  const row = core.comparePlans(j, t).rows.find((r) => r.address === 'local_file.config');
  assert.ok(!row.diff?.includes('content'), `diff: ${row.diff}`);
});

test('an output with unknown parts is not shown as final', () => {
  const p = json([], {
    output_changes: {
      obj: { actions: ['create'], before: null, after: { a: 1 }, after_unknown: { b: true } },
      lst: { actions: ['update'], before: ['x'], after: ['x', null], after_unknown: [false, true] },
      known: { actions: ['create'], before: null, after: 'v', after_unknown: false },
    },
  });
  const o = Object.fromEntries(p.outputs.map((x) => [x.name, x]));
  assert.deepEqual(o.obj.after, { a: 1, b: '(known after apply)' });
  assert.equal(o.obj.afterPartlyUnknown, true);
  assert.deepEqual(o.lst.after, ['x', '(known after apply)']);
  assert.equal(o.lst.afterPartlyUnknown, true);
  assert.equal(o.known.afterPartlyUnknown, undefined);
  assert.match(core.toMarkdown(p, { title: 't' }), /parts known after apply/);
  const text = ['Changes to Outputs:', '  + obj = {', '      + a = 1', '      + b = (known after apply)', '    }', '', 'Plan: 0 to add, 0 to change, 0 to destroy.'].join('\n');
  const t = core.parsePlan(text);
  assert.deepEqual(t.outputs[0].after, { a: 1, b: '(known after apply)' });
  assert.equal(t.outputs[0].afterPartlyUnknown, true);
});

test('an added or removed blank line in a heredoc diff', () => {
  const text = ['Terraform will perform the following actions:', '', '  # aws_instance.web will be updated in-place', '  ~ resource "aws_instance" "web" {', '      ~ user_data = <<-EOT', '            line1', '          + ', '            line2', '          - old', '          - ', '        EOT', '    }', '', 'Plan: 0 to add, 1 to change, 0 to destroy.'].join('\n');
  const a = attr(byAddress(core.parsePlan(text), 'aws_instance.web'), 'user_data');
  assert.equal(a.before, 'line1\nline2\nold\n\n');
  assert.equal(a.after, 'line1\n\nline2\n');
});

test('a resource removed from a module that is still there is no_resource_config', () => {
  const head = (addr, why) => ['Terraform will perform the following actions:', '', `  # ${addr} will be destroyed`, `  # (because ${why} is not in configuration)`, `  - resource "aws_instance" "web" {`, '      - ami = "x" -> null', '    }', '', 'Plan: 0 to add, 0 to change, 1 to destroy.'].join('\n');
  assert.equal(core.parsePlan(head('module.app.aws_instance.web', 'module.app.aws_instance.web')).resources[0].reason, 'delete_because_no_resource_config');
  assert.equal(core.parsePlan(head('module.app.aws_instance.web', 'module.app')).resources[0].reason, 'delete_because_no_module');
  assert.equal(core.parsePlan(head('module.a["x"].module.b[0].aws_instance.web', 'module.a["x"].module.b[0]')).resources[0].reason, 'delete_because_no_module');
});

test('list elements in text go by their index in the new list; a removed one by its old index', () => {
  const text = ['Terraform will perform the following actions:', '', '  # a.b will be updated in-place', '  ~ resource "a" "b" {', '      ~ list = [', '          - "a",', '          + "b",', '            "c",', '        ]', '    }', '', 'Plan: 0 to add, 1 to change, 0 to destroy.'].join('\n');
  const list = attr(byAddress(core.parsePlan(text), 'a.b'), 'list');
  assert.deepEqual(
    list.children.map((c) => [c.path, c.kind]),
    [
      ['list[was 0]', 'remove'],
      ['list[0]', 'add'],
      ['list[1]', 'same'],
    ],
  );
});

test('["create","forget"]: the new object is a create, diffed as usual', () => {
  const p = json([rc('a.b', ['create', 'forget'], { before: { x: 1 }, after: { x: 2 } })]);
  const r = byAddress(p, 'a.b');
  assert.equal(r.action, 'create');
  assert.equal(p.counts.create, 1);
  assert.equal(p.counts.forget, 0);
  assert.deepEqual([attr(r, 'x').before, attr(r, 'x').after], [1, 2]);
  assert.ok(p.notes.some((n) => /a\.b.*removed from the state/.test(n)));
  assert.equal(byAddress(json([rc('a.c', ['forget'], { before: { x: 1 } })]), 'a.c').action, 'forget');
});

test('telling whether text is a plan takes linear time on blank lines', () => {
  for (const s of ['\n'.repeat(4 * 1024 * 1024), '\r\n'.repeat(1024 * 1024), ' \n'.repeat(1024 * 1024)]) {
    const t0 = performance.now();
    assert.equal(core.detectPlan(s), undefined);
    const ms = performance.now() - t0;
    assert.ok(ms < 500, `${ms.toFixed(0)} ms for ${s.length} chars`);
  }
});

test('a zip listing one big entry thousands of times is inflated once', () => {
  const data = deflateRawSync(Buffer.alloc(32 * 1024 * 1024));
  const name = Buffer.from('tfplan');
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(32 * 1024 * 1024, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(32 * 1024 * 1024, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(0, 42);
  const n = 5000;
  const record = Buffer.concat([central, name]);
  const cd = Buffer.concat(Array.from({ length: n }, () => record));
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(n, 8);
  eocd.writeUInt16LE(n, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(local.length + name.length + data.length, 16);
  const zip = Buffer.concat([local, name, data, cd, eocd]);
  const t0 = performance.now();
  tfplan.inspectBinaryPlan(zip);
  const ms = performance.now() - t0;
  assert.ok(ms < 2000, `${ms.toFixed(0)} ms`);
});

test('aligning lists of big, nearly equal elements costs the size once, not per pair', () => {
  const list = (last) => Array.from({ length: 1000 }, (_, i) => [...Array.from({ length: 999 }, (_, k) => k + i), last]);
  const t0 = performance.now();
  core.alignLists(list(0), list(1));
  const ms = performance.now() - t0;
  assert.ok(ms < 3000, `${ms.toFixed(0)} ms`);
});

test('an output with a sensitive part is masked whole', () => {
  const p = json([], { output_changes: { o: { actions: ['create'], before: null, after: { a: 1, s: 'secret' }, after_unknown: false, after_sensitive: { s: true } } } });
  assert.equal(p.outputs[0].afterSensitive, true);
  assert.doesNotMatch(core.toMarkdown(p, { title: 't' }), /secret/);
});

test('lost colour codes inside a heredoc body are left alone, values and all', () => {
  const text = [
    'Terraform will perform the following actions:',
    '',
    '[1m  # local_file.r[0m will be created',
    '[0m  [32m+[0m[0m resource "local_file" "r" {',
    '      [32m+[0m[0m content = <<-EOT',
    '            expr: rate(x[5m:1m])',
    '            note: [1m bold',
    '        EOT',
    '      [32m+[0m[0m id      = (known after apply)',
    '    }',
    '',
    '[1mPlan:[0m 1 to add, 0 to change, 0 to destroy.',
  ].join('\n');
  const p = core.parsePlan(text);
  const r = byAddress(p, 'local_file.r');
  assert.equal(attr(r, 'content').after, 'expr: rate(x[5m:1m])\nnote: [1m bold\n');
  assert.equal(attr(r, 'id').afterUnknown, true);
  assert.equal(p.planLine, 'Plan: 1 to add, 0 to change, 0 to destroy.');
  // A coloured heredoc diff: the codes around the symbols go, the text stays.
  const diff = [
    'Terraform will perform the following actions:',
    '',
    '[1m  # local_file.r[0m will be updated in-place',
    '[0m  [33m~[0m[0m resource "local_file" "r" {',
    '      [33m~[0m[0m content = <<-EOT',
    '            a[5m]',
    '          [31m-[0m[0m old[1m x',
    '          [32m+[0m[0m new[1m x',
    '        EOT',
    '    }',
    '',
    '[1mPlan:[0m 0 to add, 1 to change, 0 to destroy.',
  ].join('\n');
  const c = attr(byAddress(core.parsePlan(diff), 'local_file.r'), 'content');
  assert.deepEqual([c.before, c.after], ['a[5m]\nold[1m x\n', 'a[5m]\nnew[1m x\n']);
});

test('trimming a long run of spaces at the end of a line takes linear time', () => {
  const text = ['Terraform will perform the following actions:', '', '  # a.b will be created', '  + resource "a" "b" {', `      + v = "${' '.repeat(200_000)}x"`, '    }', '', 'Plan: 1 to add, 0 to change, 0 to destroy.'].join('\n');
  const t0 = performance.now();
  core.parsePlan(text);
  const ms = performance.now() - t0;
  assert.ok(ms < 300, `${ms.toFixed(0)} ms`);
  const t1 = performance.now();
  core.cleanLog(`${' '.repeat(200_000)}x\n`);
  assert.ok(performance.now() - t1 < 100);
});

test('null to an object or list with unknown parts keeps them unknown', () => {
  const p = json([rc('t.a', ['update'], { before: { sg: null, blk: null }, after: { sg: [null], blk: { x: 1 } }, after_unknown: { sg: [true], blk: { y: true } } })]);
  const r = byAddress(p, 't.a');
  assert.equal(attr(r, 'sg[0]').afterUnknown, true);
  assert.equal(attr(r, 'blk.x').after, 1);
  assert.equal(attr(r, 'blk.y').afterUnknown, true);
  assert.doesNotMatch(core.toMarkdown(p, { title: 't' }), /\| `sg` \| `null` \| `\[null\]`/);
});

test('a multi-line string that becomes unknown is not shown as every line removed', () => {
  const p = json([rc('t.a', ['update'], { before: { user_data: '#!/bin/bash\necho a\n' }, after: {}, after_unknown: { user_data: true } })]);
  const md = core.toMarkdown(p, { title: 't' });
  assert.match(md, /\| `user_data` \| _see below_ \| \(known after apply\) \|/);
  assert.doesNotMatch(md, /^-#!\/bin\/bash$/m);
  assert.match(md, /current value/);
});

test('refresh-only output with no drift is a plan with no changes', () => {
  const text = 'No changes. Your infrastructure still matches the configuration.\n\nTerraform has checked that the real remote objects still match the result of your most\nrecent changes, and found no differences.\n';
  const p = core.parsePlan(text);
  assert.equal(p.resources.length, 0);
  assert.equal(p.planLine, 'No changes. Your infrastructure still matches the configuration.');
});

test('the elision in a heredoc diff is counted, not read as a line', () => {
  const text = [
    'Terraform will perform the following actions:',
    '',
    '  # aws_instance.web will be updated in-place',
    '  ~ resource "aws_instance" "web" {',
    '      ~ user_data = <<-EOT',
    '            #!/bin/bash',
    '          - echo old',
    '          + echo new',
    '            # (12 unchanged lines hidden)',
    '        EOT',
    '    }',
  ].join('\n');
  const a = attr(byAddress(core.parsePlan(text), 'aws_instance.web'), 'user_data');
  assert.equal(a.before, '#!/bin/bash\necho old\n');
  assert.equal(a.after, '#!/bin/bash\necho new\n');
  assert.equal(a.hidden, 12);
});

test("a plan's JSON and its own text output compare clean", () => {
  const c = core.comparePlans(core.parsePlan(real('create.json')), core.parsePlan(real('create.plan.txt')));
  assert.deepEqual(c.rows.filter((r) => r.status !== 'same').map((r) => [r.address, r.diff]), []);
  const j = json([rc('t.a', ['update'], { before: { cidr: ['10.0.0.0/8', 'x'] }, after: { cidr: ['10.1.0.0/16', 'x'] } })]);
  const t = core.parsePlan(['Terraform will perform the following actions:', '', '  # t.a will be updated in-place', '  ~ resource "t" "a" {', '      ~ cidr = [', '          - "10.0.0.0/8",', '          + "10.1.0.0/16",', '            "x",', '        ]', '    }', '', 'Plan: 0 to add, 1 to change, 0 to destroy.'].join('\n'));
  assert.equal(core.comparePlans(j, t).counts.attrs, 0);
  // A real difference in the list still shows.
  const k = json([rc('t.a', ['update'], { before: { cidr: ['10.0.0.0/8', 'x'] }, after: { cidr: ['10.2.0.0/16', 'x'] } })]);
  assert.deepEqual(core.comparePlans(k, t).rows[0].diff, ['cidr']);
});

test('the search matches the words a reason is shown as', () => {
  const row = { address: 'local_file.notes["b"]', type: 'local_file', action: 'delete', reason: 'delete_because_each_key', keys: [], forces: [] };
  const f = (query) => ({ actions: {}, query, type: '', destructiveOnly: false, showUnchanged: false });
  assert.equal(model.rowMatches(row, f('for_each')), true);
  assert.equal(model.rowMatches(row, f('no longer')), true);
  assert.equal(model.rowMatches(row, f('each_key')), true);
});
