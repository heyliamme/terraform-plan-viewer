// Copy as Markdown and Copy summary.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { core, fixture, planDoc, rc, real } from './helpers.mjs';

test('the Markdown has a summary table, details per resource, outputs and failing checks', () => {
  const p = core.parsePlan(real('changes.json'));
  const md = core.toMarkdown(p, { title: 'changes.json' });
  assert.ok(md.startsWith('### Terraform plan: changes.json\n\n**3 to add**, 1 to change, **4 to destroy**, **3 to replace**, 1 to import, 4 moved, 1 to forget, 2 to read · OpenTofu 1.13.1, planned 2026-10-21T10:38:04Z\n'), md.slice(0, 300));
  assert.ok(md.includes('| Action | Count | Resource types |'));
  assert.ok(md.includes('| - destroy | 4 | `local_file`, `null_resource`, `random_integer` |'));
  assert.ok(md.includes('| -/+ replace | 3 | `local_file`, `null_resource` |'));
  assert.ok(md.includes('#### Changed outside of OpenTofu (1)\n\n- `local_file.notes["a"]`: deleted'));
  // Destructive first, each in a folded details block with an attribute table.
  const first = md.indexOf('<details>');
  assert.ok(md.slice(first, first + 200).includes('— destroy'), md.slice(first, first + 200));
  assert.ok(md.includes('<summary>-/+ <code>local_file.config</code> — replace (the provider can\'t update it in place; forced by <code>content</code>)</summary>'));
  assert.ok(md.includes('| `content.env` | `"staging"` | `"production"` |'));
  assert.ok(md.includes('| `id` | `"b7ce96924440591b57f51a503aa48c4faa2466ca"` | (known after apply) |'));
  assert.ok(md.includes('<summary>+/- <code>null_resource.cbd</code> — replace (create before destroy;'));
  assert.ok(md.includes('Moved from `random_pet.legacy`; no other change.'));
  assert.ok(md.includes('Removed from the state; the real object is kept.'));
  assert.ok(md.includes('Imported from `p-9hUg`; the configuration matches.'));
  assert.ok(md.includes('#### Outputs (3)'));
  assert.ok(md.includes('| `to_remove` | destroy | `"bye"` |  |'));
  assert.ok(md.includes('| `rotated_at` | create |  | (known after apply) |'));
  assert.ok(md.includes('#### Checks not passing (1)\n\n- `check.env_is_staging`: fail — env is not staging'));
  assert.ok(md.includes('> **Warning:**') === false, 'JSON plans carry no warnings');
});

test('sensitive values are masked in Markdown whatever the view shows', () => {
  const p = core.parsePlan(real('sensitive.json'));
  const md = core.toMarkdown(p, { title: 'sensitive.json' });
  // A replaced password: the old one is masked, the new one isn't known yet.
  assert.ok(md.includes('| `result` | (sensitive) | (known after apply) |'), md);
  assert.ok(md.includes('| `length` (forces replacement) | `16` | `20` |'));
  assert.ok(md.includes('| `content` (forces replacement) | (sensitive) | (known after apply) |'));
  assert.ok(md.includes('| `password` | update | (sensitive) | (known after apply) |'));
  const secret = p.resources.find((r) => r.address === 'local_sensitive_file.secret');
  const value = core.attrAt(secret.attrs, 'content').before;
  assert.ok(typeof value === 'string' && value.length > 5 && !md.includes(value), 'the secret itself is not in the Markdown');
});

test('multi-line strings become diff blocks', () => {
  const p = core.parsePlan(fixture('handwritten/terraform-1.x.txt'));
  const md = core.toMarkdown(p, { title: 'plan.txt' });
  assert.ok(md.includes('| `user_data` | _see below_ | _see below_ |'));
  assert.ok(md.includes('**`user_data`**\n\n```diff\n #!/bin/bash\n-echo "hello from staging" > /etc/motd\n+echo "hello from production" > /etc/motd\n systemctl restart nginx\n```'), md);
  assert.ok(md.includes('> **Warning:** Deprecated attribute'));
  assert.ok(md.includes('#### Changed outside of Terraform (2)'));
});

test('summary only, and the plain summary', () => {
  const p = core.parsePlan(real('changes.json'));
  const md = core.toMarkdown(p, { title: 'changes.json', summaryOnly: true });
  assert.ok(!md.includes('<details>'));
  assert.ok(md.includes('#### Destroy (4)\n\n- `local_file.notes["b"]` — key no longer in for_each'));
  const s = core.toSummary(p, 'changes.json');
  assert.ok(s.startsWith('changes.json: 3 to add, 1 to change, 4 to destroy, 3 to replace, 1 to import, 4 moved, 1 to forget, 2 to read, 1 changed outside\n\ndestroy:\n  - local_file.notes["b"]\n'), s);
  assert.ok(s.includes('replace:\n  -/+ local_file.config (forced by content)\n  +/- null_resource.cbd (forced by triggers)'));
  assert.ok(s.includes('outputs:\n  + replicas\n  + rotated_at\n  - to_remove\n'));
});

test('names with backticks and pipes are safe in tables', () => {
  const p = core.parsePlanJson(JSON.stringify(planDoc([rc('aws_x.y', ['update'], { before: { 'we|ird`key': 'a|b' }, after: { 'we|ird`key': 'c`d' } })])));
  const md = core.toMarkdown(p, { title: 'x | y' });
  assert.ok(md.includes('### Terraform plan: x \\| y'));
  assert.ok(md.includes('| ``["we\\|ird`key"]`` | `"a\\|b"` | ``"c`d"`` |'), md);
});

test('an errored plan and a plan with nothing', () => {
  const e = core.toMarkdown(core.parsePlan(real('errored.json')), { title: 'errored.json' });
  assert.ok(e.includes('> **The plan failed part way through.**'));
  // Nothing to apply, but a data source is read again for a check block: that is listed.
  const n = core.toMarkdown(core.parsePlan(real('nochanges.json')), { title: 'nochanges.json' });
  assert.ok(n.includes('0 to add, 0 to change, 0 to destroy, 1 to read'), n);
  assert.ok(n.includes('| <= read | 1 | `local_file` |'));
  assert.ok(!n.includes('— destroy'));
  const empty = core.toMarkdown(core.parsePlan('No changes. Your infrastructure matches the configuration.\n'), { title: 'plan.txt' });
  assert.ok(empty.includes('No changes.'));
  assert.ok(!empty.includes('<details>'));
});
