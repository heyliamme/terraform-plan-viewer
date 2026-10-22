// Reads plan JSON (`terraform show -json plan.tfplan`, format versions 0.1 to 1.2, and
// OpenTofu's) into the plan model.
import { anyTrue, countLeaves, diffChange, forcedPaths, withUnknownParts } from './diff';
import { countPlan, parseResourceAddress, splitAddress, type Action, type Check, type CheckInstance, type Diagnostic, type OutputChange, type Plan, type ReplaceOrder, type ResourceChange, type Value } from './model';

export class PlanJsonError extends Error {}

interface RawChange {
  actions?: unknown;
  before?: Value;
  after?: Value;
  after_unknown?: unknown;
  before_sensitive?: unknown;
  after_sensitive?: unknown;
  replace_paths?: unknown;
  importing?: { id?: unknown; unknown?: unknown } | null;
  generated_config?: unknown;
}

interface RawResourceChange {
  address?: unknown;
  previous_address?: unknown;
  module_address?: unknown;
  mode?: unknown;
  type?: unknown;
  name?: unknown;
  index?: unknown;
  deposed?: unknown;
  action_reason?: unknown;
  provider_name?: unknown;
  change?: RawChange;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** Whether a parsed JSON document is a plan (as opposed to state, or anything else). */
export function isPlanJson(v: unknown): v is Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  if (typeof o.format_version !== 'string') return false;
  return Array.isArray(o.resource_changes) || Array.isArray(o.resource_drift) || !!(o.planned_values && typeof o.planned_values === 'object') || !!(o.output_changes && typeof o.output_changes === 'object');
}

/** What kind of JSON this is, for an error message. */
export function describeJson(v: unknown): string {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return 'not a JSON object';
  const o = v as Record<string, unknown>;
  if (typeof o.format_version === 'string' && o.values && !o.resource_changes) return 'a Terraform state file (`terraform show -json` without a plan), not a plan';
  if (o.version && o.resources && o.lineage) return 'a Terraform state file (terraform.tfstate), not a plan';
  if (o.provider_schemas) return 'provider schemas, not a plan';
  if (typeof o.format_version !== 'string') return 'JSON without a `format_version`';
  return 'JSON without `resource_changes`';
}

export function actionOf(actions: string[], previousAddress?: string, importing?: boolean): { action: Action; order?: ReplaceOrder } {
  const a = actions.map((x) => String(x));
  const has = (x: string) => a.includes(x);
  if (has('delete') && has('create')) return { action: 'replace', order: a.indexOf('create') < a.indexOf('delete') ? 'create-delete' : 'delete-create' };
  // ["create","forget"] (CreateThenForget): a new object is created and the old one only
  // dropped from the state. The new object is the change to review: a create.
  if (has('forget') && !has('create')) return { action: 'forget' };
  if (has('create')) return { action: 'create' };
  if (has('delete')) return { action: 'delete' };
  if (has('update')) return { action: 'update' };
  if (has('read')) return { action: 'read' };
  if (has('no-op') || a.length === 0) {
    if (importing) return { action: 'import' };
    if (previousAddress) return { action: 'move' };
    return { action: 'no-op' };
  }
  // Something newer than this reader: keep the plan readable.
  return { action: 'update' };
}

function readResourceChange(raw: RawResourceChange, i: number): ResourceChange {
  const address = str(raw.address) ?? `#${i}`;
  const change = raw.change ?? {};
  const actions = Array.isArray(change.actions) ? change.actions.map((x) => String(x)) : [];
  const previousAddress = str(raw.previous_address);
  let importId: string | undefined;
  let importIdUnknown = false;
  if (change.importing && typeof change.importing === 'object') {
    importId = str(change.importing.id) ?? '';
    if (change.importing.unknown === true || importId === '') importIdUnknown = importId === '';
  }
  const { action, order } = actionOf(actions, previousAddress, importId !== undefined);
  const split = splitAddress(address);
  const parsed = parseResourceAddress(split.resource);
  const replacePaths = Array.isArray(change.replace_paths) ? (change.replace_paths as unknown[]).filter(Array.isArray).map((p) => (p as unknown[]).map((k) => (typeof k === 'number' ? k : String(k)))) : undefined;
  // A forgotten resource keeps its object; only the state lets go of it. Its attributes
  // are shown as they are, not as removed.
  const forget = action === 'forget';
  const attrs = diffChange({
    before: change.before ?? undefined,
    after: forget ? (change.before ?? undefined) : (change.after ?? undefined),
    afterUnknown: forget ? undefined : change.after_unknown,
    beforeSensitive: change.before_sensitive,
    afterSensitive: forget ? change.before_sensitive : change.after_sensitive,
    replacePaths,
  });
  const n = countLeaves(attrs);
  const rc: ResourceChange = {
    address,
    module: str(raw.module_address) ?? split.module,
    mode: raw.mode === 'data' ? 'data' : 'managed',
    type: str(raw.type) ?? parsed.type,
    name: str(raw.name) ?? parsed.name,
    action,
    actions,
    attrs,
    forces: forcedPaths(attrs),
    changedKeys: attrs.filter((a) => a.kind !== 'same').map((a) => a.key),
    n,
  };
  if (order) rc.replaceOrder = order;
  if (previousAddress) rc.previousAddress = previousAddress;
  const index = raw.index !== undefined && raw.index !== null ? raw.index : parsed.index;
  if (typeof index === 'string' || typeof index === 'number') rc.index = index;
  if (typeof raw.deposed === 'string') rc.deposed = raw.deposed;
  if (typeof raw.action_reason === 'string') rc.reason = raw.action_reason;
  if (importId !== undefined) {
    rc.importId = importId;
    if (importIdUnknown) rc.importIdUnknown = true;
  }
  if (typeof raw.provider_name === 'string') rc.providerName = raw.provider_name;
  return rc;
}

function readOutputs(raw: unknown): OutputChange[] {
  if (!raw || typeof raw !== 'object') return [];
  const out: OutputChange[] = [];
  for (const [name, v] of Object.entries(raw as Record<string, { actions?: unknown; before?: Value; after?: Value; after_unknown?: unknown; before_sensitive?: unknown; after_sensitive?: unknown }>)) {
    if (!v || typeof v !== 'object') continue;
    const actions = Array.isArray(v.actions) ? v.actions.map(String) : [];
    const action: OutputChange['action'] = actions.includes('create') ? 'create' : actions.includes('delete') ? 'delete' : actions.includes('update') ? 'update' : 'no-op';
    const o: OutputChange = { name, action };
    if (v.before !== undefined && v.before !== null) o.before = v.before;
    else if (v.before === null && action !== 'create') o.before = null;
    if (v.after !== undefined && v.after !== null) o.after = v.after;
    else if (v.after === null && action !== 'delete' && v.after_unknown !== true) o.after = null;
    if (v.after_unknown === true) o.afterUnknown = true;
    else if (anyTrue(v.after_unknown) && action !== 'delete') {
      // Partly unknown: shown with its unknown parts marked, not as if final.
      o.after = withUnknownParts(v.after ?? undefined, v.after_unknown);
      o.afterPartlyUnknown = true;
    }
    // Anything sensitive inside an output masks all of it: outputs are shown whole.
    if (anyTrue(v.before_sensitive)) o.beforeSensitive = true;
    if (anyTrue(v.after_sensitive)) o.afterSensitive = true;
    out.push(o);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function readChecks(raw: unknown): Check[] {
  if (!Array.isArray(raw)) return [];
  const out: Check[] = [];
  for (const c of raw as Array<Record<string, unknown>>) {
    if (!c || typeof c !== 'object') continue;
    const addr = (c.address ?? {}) as Record<string, unknown>;
    const instances: CheckInstance[] = [];
    for (const inst of (Array.isArray(c.instances) ? c.instances : []) as Array<Record<string, unknown>>) {
      const ia = (inst.address ?? {}) as Record<string, unknown>;
      instances.push({
        address: str(ia.to_display) ?? str(addr.to_display) ?? '',
        status: statusOf(inst.status),
        problems: (Array.isArray(inst.problems) ? inst.problems : []).map((p: { message?: unknown }) => str(p?.message) ?? '').filter(Boolean),
      });
    }
    out.push({ address: str(addr.to_display) ?? '', kind: str(addr.kind) ?? 'check', status: statusOf(c.status), instances });
  }
  return out;
}

const statusOf = (s: unknown): Check['status'] => (s === 'pass' || s === 'fail' || s === 'error' ? s : 'unknown');

/** The provider registry the plan's providers come from says which tool wrote it. */
function flavorOf(doc: Record<string, unknown>, resources: ResourceChange[]): Plan['flavor'] {
  const names: string[] = [];
  const cfg = doc.configuration as { provider_config?: Record<string, { full_name?: unknown; name?: unknown }> } | undefined;
  if (cfg?.provider_config && typeof cfg.provider_config === 'object') for (const p of Object.values(cfg.provider_config)) if (typeof p?.full_name === 'string') names.push(p.full_name);
  for (const r of resources) if (r.providerName) names.push(r.providerName);
  if (names.some((n) => n.includes('registry.opentofu.org'))) return 'opentofu';
  if (names.some((n) => n.includes('registry.terraform.io'))) return 'terraform';
  // OpenTofu started at 1.6: anything older is Terraform.
  const v = str(doc.terraform_version);
  const m = v && /^(\d+)\.(\d+)/.exec(v);
  if (m && (Number(m[1]) === 0 || (Number(m[1]) === 1 && Number(m[2]) < 6))) return 'terraform';
  return 'unknown';
}

export function readPlanJson(doc: unknown, t0 = Date.now()): Plan {
  if (!isPlanJson(doc)) throw new PlanJsonError(`This is ${describeJson(doc)}.`);
  const raw = Array.isArray(doc.resource_changes) ? (doc.resource_changes as RawResourceChange[]) : [];
  const resources = raw.map((r, i) => readResourceChange(r, i));
  const drift = (Array.isArray(doc.resource_drift) ? (doc.resource_drift as RawResourceChange[]) : []).map((r, i) => readResourceChange(r, i));
  const outputs = readOutputs(doc.output_changes);
  const checks = readChecks(doc.checks);
  const relevantAttributes = (Array.isArray(doc.relevant_attributes) ? doc.relevant_attributes : [])
    .filter((r: { resource?: unknown }) => r && typeof r.resource === 'string')
    .map((r: { resource: string; attribute?: unknown }) => ({ resource: r.resource, attribute: Array.isArray(r.attribute) ? r.attribute.map((k: unknown) => (typeof k === 'number' ? k : String(k))) : [] }));
  let variables: Record<string, Value> | undefined;
  if (doc.variables && typeof doc.variables === 'object') {
    variables = {};
    for (const [k, v] of Object.entries(doc.variables as Record<string, { value?: Value }>)) if (v && typeof v === 'object' && 'value' in v) variables[k] = v.value as Value;
  }
  const diagnostics: Diagnostic[] = [];
  if (doc.errored === true) diagnostics.push({ severity: 'error', summary: 'The plan failed part way through. What is shown is what Terraform had planned before the error; the real plan may differ.' });
  const plan: Plan = {
    source: 'json',
    flavor: flavorOf(doc, [...resources, ...drift]),
    formatVersion: str(doc.format_version),
    terraformVersion: str(doc.terraform_version),
    timestamp: str(doc.timestamp),
    resources,
    drift,
    outputs,
    checks,
    relevantAttributes,
    variables,
    diagnostics,
    unparsed: [],
    notes: [],
    counts: countPlan(resources, drift, outputs),
    ms: 0,
  };
  for (const r of resources)
    if (r.actions.includes('create') && r.actions.includes('forget')) plan.notes.push(`${r.address} is created anew; the object it replaces is only removed from the state, not destroyed.`);
  if (doc.errored === true) plan.errored = true;
  if (typeof doc.complete === 'boolean') plan.complete = doc.complete;
  if (typeof doc.applyable === 'boolean') plan.applyable = doc.applyable;
  plan.ms = Date.now() - t0;
  return plan;
}

/** Whether JSON.parse hands a reviver the number's source text (V8 11.4+, Node 21+, VS Code's Electron). */
const sourceText = (() => {
  let ok = false;
  try {
    JSON.parse('1', (_k, v, ctx?: { source?: string }) => ((ok = typeof ctx?.source === 'string'), v));
  } catch {
    /* older engines */
  }
  return ok;
})();

/** An integer of 16 digits or more outside a string: maybe past 2^53. */
const LONG_INT = /[[:,]\s*-?\d{16}/;

/**
 * Integers past 2^53 (int64 limits, byte counts) would be rounded by JSON.parse and two
 * different values could compare equal: they are kept as their digits, a string.
 */
function keepBigInts(_k: string, v: unknown, ctx?: { source?: string }): unknown {
  if (typeof v === 'number' && !Number.isSafeInteger(v) && ctx?.source && /^-?\d+$/.test(ctx.source)) return ctx.source;
  return v;
}

export function parsePlanJson(text: string): Plan {
  const t0 = Date.now();
  let doc: unknown;
  try {
    doc = sourceText && LONG_INT.test(text) ? JSON.parse(text, keepBigInts as never) : JSON.parse(text);
  } catch (e) {
    throw new PlanJsonError(`Not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  return readPlanJson(doc, t0);
}
