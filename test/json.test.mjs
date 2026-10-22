// Plan JSON: every action kind, sensitive and unknown values, drift, moves, imports,
// outputs, checks, format versions, and what isn't a plan.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { attr, byAddress, core, planDoc, rc, real } from './helpers.mjs';

const parse = (doc) => core.parsePlanJson(JSON.stringify(doc));

test('real OpenTofu plan: counts, actions and metadata', () => {
  const p = core.parsePlan(real('changes.json'));
  assert.equal(p.source, 'json');
  assert.equal(p.flavor, 'opentofu');
  assert.equal(p.formatVersion, '1.2');
  assert.equal(p.terraformVersion, '1.13.1');
  assert.deepEqual(p.counts, { create: 3, update: 1, delete: 4, replace: 3, read: 2, move: 4, import: 1, forget: 1, noop: 7, drift: 1, outputs: 3 });
  assert.equal(core.summaryLine(p.counts), '3 to add, 1 to change, 4 to destroy, 3 to replace, 1 to import, 4 moved, 1 to forget, 2 to read');
  const actions = Object.fromEntries(p.resources.map((r) => [r.address, r.action]));
  assert.equal(actions['local_file.config'], 'replace');
  assert.equal(actions['null_resource.cbd'], 'replace');
  assert.equal(byAddress(p, 'null_resource.cbd').replaceOrder, 'create-delete');
  assert.equal(byAddress(p, 'null_resource.hook').replaceOrder, 'delete-create');
  assert.equal(actions['null_resource.forgotten'], 'forget');
  assert.equal(actions['random_id.imported'], 'import');
  assert.equal(byAddress(p, 'random_id.imported').importId, 'p-9hUg');
  assert.equal(actions['random_pet.renamed'], 'move');
  assert.equal(byAddress(p, 'random_pet.renamed').previousAddress, 'random_pet.legacy');
  assert.equal(actions['terraform_data.settings'], 'update');
  assert.equal(actions['data.local_file.stamp_read'], 'read');
  assert.equal(byAddress(p, 'data.local_file.stamp_read').reason, 'read_because_dependency_pending');
  assert.equal(byAddress(p, 'local_file.notes["b"]').reason, 'delete_because_each_key');
  assert.equal(byAddress(p, 'local_file.notes["b"]').index, 'b');
  assert.equal(byAddress(p, 'module.child[1].random_integer.n').module, 'module.child[1]');
  assert.equal(byAddress(p, 'module.child[1].random_integer.n').reason, 'delete_because_no_module');
});

test('real plan: replace paths mark the attribute and the resource', () => {
  const p = core.parsePlan(real('changes.json'));
  const config = byAddress(p, 'local_file.config');
  assert.deepEqual(config.forces, ['content']);
  const content = attr(config, 'content');
  assert.equal(content.forcesReplacement, true);
  assert.equal(content.encoded, 'json', 'a jsonencode() string is shown as the JSON inside it');
  assert.equal(attr(config, 'content.env').kind, 'change');
  assert.deepEqual([attr(config, 'content.env').before, attr(config, 'content.env').after], ['staging', 'production']);
  assert.equal(attr(config, 'content.tags.tier').after, 'api');
  assert.equal(attr(config, 'content.created').kind, 'same');
  assert.equal(attr(config, 'id').afterUnknown, true);
  assert.deepEqual(config.changedKeys, ['content', 'content_base64sha256', 'content_base64sha512', 'content_md5', 'content_sha1', 'content_sha256', 'content_sha512', 'id']);
});

test('real plan: drift, outputs, checks, relevant attributes, variables', () => {
  const p = core.parsePlan(real('changes.json'));
  assert.equal(p.drift.length, 1);
  assert.equal(p.drift[0].address, 'local_file.notes["a"]');
  assert.equal(p.drift[0].action, 'delete');
  assert.deepEqual(p.outputs.filter((o) => o.action !== 'no-op').map((o) => [o.name, o.action]), [['replicas', 'create'], ['rotated_at', 'create'], ['to_remove', 'delete']]);
  assert.equal(p.outputs.find((o) => o.name === 'rotated_at').afterUnknown, true);
  assert.equal(p.outputs.find((o) => o.name === 'password').beforeSensitive, true);
  assert.deepEqual(p.checks.map((c) => [c.address, c.status]), [['check.config_present', 'pass'], ['check.env_is_staging', 'fail'], ['terraform_data.settings', 'pass']]);
  assert.deepEqual(p.checks[1].instances[0].problems, ['env is not staging']);
  assert.ok(p.relevantAttributes.some((r) => r.resource === 'random_pet.server' && r.attribute[0] === 'id'));
  assert.deepEqual(p.variables, { env: 'production' });
});

test('real plan: sensitive values are flagged on both sides', () => {
  const p = core.parsePlan(real('sensitive.json'));
  const pw = byAddress(p, 'random_password.db');
  assert.equal(pw.action, 'replace');
  assert.deepEqual(pw.forces, ['length']);
  const result = attr(pw, 'result');
  assert.equal(result.beforeSensitive, true);
  assert.equal(result.afterSensitive, true);
  assert.equal(result.kind, 'change');
  assert.equal(typeof result.before, 'string', 'the value is there for the host; the view masks it');
  const secret = byAddress(p, 'local_sensitive_file.secret');
  assert.equal(attr(secret, 'content').forcesReplacement, true);
  assert.equal(attr(secret, 'content').beforeSensitive, true);
  const masked = core.maskAttrs(pw.attrs);
  const m = core.attrAt(masked, 'result');
  assert.equal(m.before, undefined);
  assert.equal(m.maskedBefore, true);
  assert.equal(m.afterUnknown, true, 'the new password is only known after apply');
  const secretContent = core.attrAt(core.maskAttrs(secret.attrs), 'content');
  assert.equal(secretContent.maskedBefore, true);
  const revealed = core.attrAt(core.maskAttrs(pw.attrs, new Set(['result'])), 'result');
  assert.equal(typeof revealed.before, 'string');
  assert.equal(revealed.maskedBefore, undefined);
  assert.equal(p.outputs.find((o) => o.name === 'password').action, 'update');
});

test('real plans: create, destroy, no changes, errored, replace by request', () => {
  const create = core.parsePlan(real('create.json'));
  assert.equal(create.counts.create, 21);
  assert.ok(create.resources.every((r) => r.action === 'create'));
  const stat = byAddress(create, 'time_static.created');
  const unknown = stat.attrs.filter((a) => a.kind !== 'same');
  assert.ok(unknown.length >= 8 && unknown.every((a) => a.kind === 'add' && a.afterUnknown), 'attributes only in after_unknown are still listed');
  assert.ok(unknown.some((a) => a.key === 'rfc3339'));
  assert.equal(attr(stat, 'triggers').kind, 'same', 'a null attribute is not a change');
  const destroy = core.parsePlan(real('destroy.json'));
  assert.equal(destroy.counts.delete, 19);
  assert.equal(destroy.outputs.filter((o) => o.action === 'delete').length, 5);
  const none = core.parsePlan(real('nochanges.json'));
  assert.equal(core.hasChanges(none.counts), false);
  const errored = core.parsePlan(real('errored.json'));
  assert.equal(errored.errored, true);
  assert.ok(errored.diagnostics.some((d) => d.severity === 'error'));
  const replace = core.parsePlan(real('replace.json'));
  assert.equal(byAddress(replace, 'random_pet.server').reason, 'replace_by_request');
  assert.equal(replace.counts.replace, 4);
});

test('every action array maps to an action', () => {
  const cases = [
    [['no-op'], 'no-op'],
    [['create'], 'create'],
    [['read'], 'read'],
    [['update'], 'update'],
    [['delete'], 'delete'],
    [['delete', 'create'], 'replace'],
    [['create', 'delete'], 'replace'],
    [['forget'], 'forget'],
  ];
  for (const [actions, want] of cases) assert.equal(core.actionOf(actions).action, want, actions.join(','));
  assert.equal(core.actionOf(['delete', 'create']).order, 'delete-create');
  assert.equal(core.actionOf(['create', 'delete']).order, 'create-delete');
  assert.equal(core.actionOf(['no-op'], 'old.addr').action, 'move');
  assert.equal(core.actionOf(['no-op'], undefined, true).action, 'import');
  assert.equal(core.actionOf(['something-new']).action, 'update', 'an unknown action keeps the plan readable');
});

test('a moved resource that also changes counts as moved and updated', () => {
  const p = parse(planDoc([rc('aws_instance.b', ['update'], { before: { ami: 'a' }, after: { ami: 'b' } }, { previous_address: 'aws_instance.a' })]));
  assert.equal(p.resources[0].action, 'update');
  assert.equal(p.resources[0].previousAddress, 'aws_instance.a');
  assert.equal(p.counts.move, 1);
  assert.equal(p.counts.update, 1);
});

test('an import that also updates keeps the import id and counts both', () => {
  const p = parse(planDoc([rc('aws_s3_bucket.b', ['update'], { before: { acl: 'private' }, after: { acl: 'public' }, importing: { id: 'my-bucket' } })]));
  assert.equal(p.resources[0].action, 'update');
  assert.equal(p.resources[0].importId, 'my-bucket');
  assert.equal(p.counts.import, 1);
  const unknown = parse(planDoc([rc('aws_s3_bucket.b', ['no-op'], { before: { acl: 'x' }, after: { acl: 'x' }, importing: { unknown: true } })]));
  assert.equal(unknown.resources[0].action, 'import');
  assert.equal(unknown.resources[0].importIdUnknown, true);
});

test('deposed objects are told apart from the live one', () => {
  const p = core.parsePlan(core.parsePlan ? JSON.stringify(JSON.parse(real('../handwritten/deposed.json'))) : '');
  const dep = p.resources.find((r) => r.deposed);
  assert.ok(dep, 'a deposed entry');
  assert.equal(dep.deposed, '8e4f2a1c');
  assert.equal(dep.action, 'delete');
  const live = p.resources.find((r) => r.address === dep.address && !r.deposed);
  assert.equal(live.action, 'no-op');
});

test('resource drift with an update lists the drifted attributes', () => {
  const p = core.parsePlan(real('../handwritten/drift-update.json'));
  assert.equal(p.drift.length, 2);
  const sg = p.drift.find((d) => d.address === 'aws_security_group.web');
  assert.equal(sg.action, 'update');
  assert.deepEqual(sg.changedKeys, ['ingress', 'tags']);
  assert.equal(attr(sg, 'tags.Owner').kind, 'remove');
  assert.equal(attr(sg, 'ingress[2]').kind, 'add', 'a rule added outside Terraform');
  assert.equal(p.drift.find((d) => d.address === 'aws_instance.old').action, 'delete');
  assert.equal(p.counts.drift, 2);
});

test('format version 0.1 (Terraform 0.12) plans read without the newer keys', () => {
  const p = core.parsePlan(real('../handwritten/format-0.1.json'));
  assert.equal(p.formatVersion, '0.1');
  assert.equal(p.flavor, 'terraform');
  assert.equal(p.counts.create, 1);
  assert.equal(p.counts.update, 1);
  assert.equal(p.counts.delete, 1);
  const web = byAddress(p, 'aws_instance.web');
  assert.equal(attr(web, 'instance_type').after, 't3.small');
  assert.equal(attr(web, 'public_ip').afterUnknown, true);
  assert.deepEqual(p.drift, []);
  assert.deepEqual(p.checks, []);
});

test('unknown values inside partly known objects', () => {
  // Unknown object attributes are left out of `after`; unknown list elements are null there.
  const p = parse(planDoc([rc('x.y', ['update'], { before: { a: { b: 1, c: 2 }, list: [1, 2] }, after: { a: { b: 1 }, list: [1, null] }, after_unknown: { a: { c: true }, list: [false, true] } })]));
  const r = p.resources[0];
  assert.equal(attr(r, 'a.c').afterUnknown, true);
  assert.equal(attr(r, 'a.c').kind, 'change');
  assert.equal(attr(r, 'a.b').kind, 'same');
  assert.equal(attr(r, 'list[1]').afterUnknown, true);
  // A whole value that becomes unknown is one leaf.
  const whole = parse(planDoc([rc('x.y', ['update'], { before: { a: { b: 1 } }, after: { a: null }, after_unknown: { a: true } })]));
  const a = attr(whole.resources[0], 'a');
  assert.equal(a.afterUnknown, true);
  assert.deepEqual(a.before, { b: 1 });
});

test('null attributes on create or delete are not changes, as Terraform shows them', () => {
  const p = parse(planDoc([rc('x.y', ['create'], { after: { name: 'n', optional: null, nested: { deep: null, set: 1 } }, after_unknown: { id: true } })]));
  const r = p.resources[0];
  assert.deepEqual(r.changedKeys, ['id', 'name', 'nested']);
  assert.equal(attr(r, 'optional').kind, 'same');
  assert.equal(attr(r, 'nested.deep').kind, 'same');
  assert.equal(attr(r, 'nested.set').kind, 'add');
  assert.deepEqual(r.n, { add: 3, change: 0, remove: 0, same: 2 });
});

test('lists are aligned by content, so an insertion is not a change to every item', () => {
  const p = parse(planDoc([rc('x.y', ['update'], { before: { l: ['a', 'b', 'c'] }, after: { l: ['a', 'x', 'b', 'c'] } })]));
  const kinds = attr(p.resources[0], 'l').children.map((c) => c.kind);
  assert.deepEqual(kinds, ['same', 'add', 'same', 'same']);
  const objs = parse(planDoc([rc('x.y', ['update'], { before: { l: [{ port: 80 }, { port: 443 }] }, after: { l: [{ port: 80 }, { port: 8443 }] } })]));
  const kinds2 = attr(objs.resources[0], 'l').children.map((c) => c.kind);
  assert.deepEqual(kinds2, ['same', 'change']);
  assert.equal(attr(objs.resources[0], 'l[1].port').after, 8443);
});

test('a sensitive container masks everything under it', () => {
  const p = parse(planDoc([rc('x.y', ['update'], { before: { creds: { user: 'u', pass: 'p' } }, after: { creds: { user: 'u', pass: 'q' } }, before_sensitive: { creds: true }, after_sensitive: { creds: true } })]));
  const masked = core.maskAttrs(p.resources[0].attrs);
  const pass = core.attrAt(masked, 'creds.pass');
  assert.equal(pass.before, undefined);
  assert.equal(pass.maskedBefore, true);
  assert.equal(pass.maskedAfter, true);
  const shown = core.attrAt(core.maskAttrs(p.resources[0].attrs, new Set(['creds'])), 'creds.pass');
  assert.equal(shown.after, 'q');
});

test('what is not a plan is named', () => {
  assert.throws(() => core.parsePlan('{"version": 4, "terraform_version": "1.0.0", "lineage": "x", "resources": []}'), /state file/);
  assert.throws(() => core.parsePlan('{"format_version": "1.0", "values": {"root_module": {}}}'), /state file/);
  assert.throws(() => core.parsePlan('{"hello": 1}'), /format_version/);
  assert.throws(() => core.parsePlan('not json at all, and not a plan either'), /doesn't look like a plan/);
  assert.throws(() => core.parsePlan('{"format_version": "1.2", "resource_changes": [}'), /Not valid JSON/);
  assert.equal(core.detectPlan('{"format_version":"1.2","resource_changes":[]}'), 'json');
  assert.equal(core.detectPlan('Plan: 3 to add, 0 to change, 0 to destroy.'), 'text');
  assert.equal(core.detectPlan('{"a": 1}'), undefined);
});

test('addresses are split into module, type, name and index', () => {
  assert.deepEqual(core.splitAddress('module.a[0].module.b["x"].aws_instance.web[2]'), { module: 'module.a[0].module.b["x"]', resource: 'aws_instance.web[2]' });
  assert.deepEqual(core.parseResourceAddress('aws_instance.web[2]'), { mode: 'managed', type: 'aws_instance', name: 'web', index: 2 });
  assert.deepEqual(core.parseResourceAddress('data.aws_ami.ubuntu'), { mode: 'data', type: 'aws_ami', name: 'ubuntu', index: undefined });
  assert.deepEqual(core.parseResourceAddress('aws_instance.web["a.b"]'), { mode: 'managed', type: 'aws_instance', name: 'web', index: 'a.b' });
  assert.deepEqual(core.modulePath('module.a[0].module.b'), ['a[0]', 'b']);
  assert.equal(core.joinPath('tags', 'Name'), 'tags.Name');
  assert.equal(core.joinPath('tags', 'my key'), 'tags["my key"]');
  assert.equal(core.joinPath('l', 3), 'l[3]');
});

test('the summary line and change detection', () => {
  const c = { ...core.emptyCounts(), create: 3, update: 1, delete: 2, replace: 1 };
  assert.equal(core.summaryLine(c), '3 to add, 1 to change, 2 to destroy, 1 to replace');
  assert.equal(core.hasChanges(core.emptyCounts()), false);
  assert.equal(core.hasChanges({ ...core.emptyCounts(), outputs: 1 }), true);
});
