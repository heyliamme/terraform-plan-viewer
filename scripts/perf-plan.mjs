// Writes a synthetic plan JSON the size of a real large one: thousands of resource changes
// across modules, with the kinds of values cloud providers produce (tag maps, nested
// blocks, long user data, policy documents), plus the prior state and planned values a real
// plan carries. Used by the perf test and for trying the viewer on something big.
//
//   node scripts/perf-plan.mjs [out.json] [resources=5200] [targetMB=20]
import { writeFileSync } from 'fs';

const out = process.argv[2] ?? 'perf-plan.json';
const count = Number(process.argv[3] ?? 5200);
const targetMB = Number(process.argv[4] ?? 20);

// A small deterministic generator, so the file is the same every time.
let seed = 42;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const pick = (a) => a[Math.floor(rnd() * a.length)];
const TYPES = ['aws_instance', 'aws_security_group', 'aws_iam_role', 'aws_s3_bucket', 'aws_lambda_function', 'aws_lb_target_group', 'aws_route53_record', 'aws_iam_policy', 'aws_cloudwatch_log_group', 'aws_ecs_service'];
const ACTIONS = [['create'], ['create'], ['update'], ['update'], ['update'], ['no-op'], ['no-op'], ['no-op'], ['delete'], ['delete', 'create'], ['create', 'delete'], ['read']];
const MODULES = ['', '', 'module.network', 'module.app[0]', 'module.app[1]', 'module.data.module.rds', 'module.observability'];

const userData = (n) => `#!/bin/bash\nset -euo pipefail\n${Array.from({ length: n }, (_, i) => `echo "step ${i}: configuring service ${i % 7}" >> /var/log/bootstrap.log`).join('\n')}\n`;
const policy = (i) => JSON.stringify({ Version: '2012-10-17', Statement: [{ Sid: `Stmt${i}`, Effect: 'Allow', Action: ['s3:GetObject', 's3:ListBucket'], Resource: [`arn:aws:s3:::bucket-${i}`, `arn:aws:s3:::bucket-${i}/*`] }] });

function attrs(i, type, after) {
  const base = {
    id: after ? null : `${type.replace(/^aws_/, '')}-${i.toString(16).padStart(8, '0')}`,
    arn: `arn:aws:${type.split('_')[1]}:us-east-1:123456789012:${type}/${i}`,
    name: `${type.replace(/^aws_/, '')}-${i}`,
    tags: { Name: `${type}-${i}`, Environment: pick(['prod', 'staging', 'dev']), Team: pick(['platform', 'data', 'web']), CostCenter: `cc-${i % 50}` },
    tags_all: { Name: `${type}-${i}`, Environment: 'prod', ManagedBy: 'terraform' },
    description: `Managed ${type} number ${i}, created by the perf generator for a plan of ${count} changes`,
    ingress: Array.from({ length: 2 }, (_, k) => ({ from_port: 80 + k, to_port: 80 + k, protocol: 'tcp', cidr_blocks: ['10.0.0.0/8'], description: `rule ${k}` })),
    user_data: userData(4),
    policy: i % 4 === 0 ? policy(i) : null,
    timeouts: null,
    enabled: true,
    count_hint: i,
  };
  return base;
}

const resource_changes = [];
const planned = [];
const prior = [];
for (let i = 0; i < count; i++) {
  const type = TYPES[i % TYPES.length];
  const module = MODULES[i % MODULES.length];
  const name = `r${i % 97}`;
  const index = i % 3 === 0 ? `["k${i % 5}"]` : i % 3 === 1 ? `[${i % 4}]` : '';
  const address = `${module ? module + '.' : ''}${type}.${name}${index}`;
  const actions = ACTIONS[i % ACTIONS.length];
  const before = actions[0] === 'create' && actions.length === 1 ? null : attrs(i, type, false);
  let after = actions.includes('delete') && actions.length === 1 ? null : attrs(i, type, true);
  if (after && before && actions.includes('update')) {
    after.tags.Environment = 'prod';
    after.description = before.description + ' (updated)';
    after.user_data = userData(5);
    after.ingress = [...before.ingress.slice(1), { from_port: 443, to_port: 443, protocol: 'tcp', cidr_blocks: ['0.0.0.0/0'], description: 'https' }];
    after.id = before.id;
  }
  const change = { actions, before, after, after_unknown: after ? { id: after.id === null, arn: actions.includes('create') } : {}, before_sensitive: before ? { user_data: true } : false, after_sensitive: after ? { user_data: true } : false };
  if (actions.length === 2) change.replace_paths = [['user_data']];
  const rc = { address, module_address: module || undefined, mode: 'managed', type, name, change };
  if (index) rc.index = i % 3 === 0 ? `k${i % 5}` : i % 4;
  if (actions.length === 2) rc.action_reason = 'replace_because_cannot_update';
  if (!rc.module_address) delete rc.module_address;
  resource_changes.push(rc);
  if (after) planned.push({ address, mode: 'managed', type, name, provider_name: 'registry.terraform.io/hashicorp/aws', schema_version: 1, values: after, sensitive_values: { user_data: true } });
  if (before) prior.push({ address, mode: 'managed', type, name, provider_name: 'registry.terraform.io/hashicorp/aws', schema_version: 1, values: before, sensitive_values: { user_data: true } });
}

const plan = {
  format_version: '1.2',
  terraform_version: '1.9.8',
  timestamp: '2026-10-21T10:00:00Z',
  variables: { environment: { value: 'prod' } },
  planned_values: { root_module: { resources: planned } },
  resource_changes,
  output_changes: { endpoint: { actions: ['update'], before: 'https://old.example.com', after: 'https://new.example.com', after_unknown: false, before_sensitive: false, after_sensitive: false } },
  prior_state: { format_version: '1.0', terraform_version: '1.9.8', values: { root_module: { resources: prior } } },
  configuration: { provider_config: { aws: { name: 'aws', full_name: 'registry.terraform.io/hashicorp/aws' } }, root_module: { resources: [] } },
  relevant_attributes: [{ resource: 'aws_instance.r0', attribute: ['id'] }],
};
let text = JSON.stringify(plan);
// Pad the configuration with resource blocks until the target size is reached.
const cfg = (i) => ({ address: `aws_instance.cfg${i}`, mode: 'managed', type: 'aws_instance', name: `cfg${i}`, provider_config_key: 'aws', expressions: { ami: { constant_value: `ami-${i.toString(16).padStart(12, '0')}` }, instance_type: { references: ['var.instance_type'] }, tags: { constant_value: { Name: `cfg${i}`, Environment: 'prod', Team: 'platform' } }, user_data: { constant_value: userData(3) } }, schema_version: 1 });
const mb = text.length / 1024 / 1024;
if (mb < targetMB) {
  const one = JSON.stringify(cfg(1)).length + 1;
  const need = Math.ceil(((targetMB - mb) * 1024 * 1024) / one);
  plan.configuration.root_module.resources = Array.from({ length: need }, (_, i) => cfg(i));
  text = JSON.stringify(plan);
}
writeFileSync(out, text);
console.log(`${out}: ${resource_changes.length} resource changes, ${(text.length / 1024 / 1024).toFixed(1)} MB`);
