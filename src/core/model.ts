// The plan model: what a reviewer needs from a plan, whichever form it came in
// (plan JSON, a binary plan read through `show -json`, or the text output in a CI log).

/** What happens to a resource instance. `replace` carries the order in `replaceOrder`. */
export type Action = 'create' | 'update' | 'delete' | 'replace' | 'read' | 'no-op' | 'move' | 'import' | 'forget';
export type ReplaceOrder = 'delete-create' | 'create-delete';

/** A plan value: JSON, as `terraform show -json` writes it. */
export type Value = null | boolean | number | string | Value[] | { [key: string]: Value };

export type AttrKind = 'same' | 'add' | 'remove' | 'change';

/** One attribute (or nested block, list element, map entry) and what the plan does to it. */
export interface Attr {
  /** The name, map key, or `[3]` for a list element. */
  key: string;
  /** Dotted path from the resource: `tags.env`, `ingress[0].port`. */
  path: string;
  kind: AttrKind;
  before?: Value;
  after?: Value;
  /** The new value is only known after apply. */
  afterUnknown?: boolean;
  beforeSensitive?: boolean;
  afterSensitive?: boolean;
  /** This attribute is why the resource is replaced (`replace_paths`, "# forces replacement"). */
  forcesReplacement?: boolean;
  /** Nested attributes, when both sides are objects or lists, or one side is and the other is absent. */
  children?: Attr[];
  /**
   * "(n unchanged attributes hidden)" in text plans: children the output left out. On a
   * multi-line string, the lines a heredoc diff left out.
   */
  hidden?: number;
  /** A nested block (`ingress { }`) rather than an attribute (`tags = { }`), as text plans tell them apart. */
  block?: boolean;
  /** The value is a string holding JSON, shown as the JSON inside it (`jsonencode(...)`). */
  encoded?: 'json';
  /** The value is masked in this copy of the tree (sent to a view); the real value stays with the host. */
  maskedBefore?: boolean;
  maskedAfter?: boolean;
}

export interface ResourceChange {
  /** Full address: `module.a[0].aws_instance.web["x"]`. */
  address: string;
  /** Where it was, for a `moved` block. */
  previousAddress?: string;
  /** `module.a[0].module.b`, empty for the root module. */
  module: string;
  mode: 'managed' | 'data';
  type: string;
  name: string;
  /** Instance key of a `count` / `for_each` resource. */
  index?: string | number;
  /** Deposed object key: an old object still to destroy after a create-before-destroy replace. */
  deposed?: string;
  action: Action;
  replaceOrder?: ReplaceOrder;
  /** The actions as the plan wrote them: `["delete", "create"]`. */
  actions: string[];
  /** `replace_because_tainted`, `delete_because_no_module`, ... or the text equivalent. */
  reason?: string;
  /** The id being imported (`import` blocks, `terraform import`). */
  importId?: string;
  /** Imported, and the id is not known until apply. */
  importIdUnknown?: boolean;
  attrs: Attr[];
  /** Dotted paths of the attributes that force the replacement. */
  forces: string[];
  /** Top-level attributes that change, for the row and for search. */
  changedKeys: string[];
  /** Leaf changes under this resource: added, changed, removed values. */
  n: { add: number; change: number; remove: number; same: number };
  /** Text plans: lines inside this resource that couldn't be read. */
  unparsed?: string[];
  /** Provider-defined, for information. */
  providerName?: string;
}

export interface OutputChange {
  name: string;
  action: 'create' | 'update' | 'delete' | 'no-op';
  before?: Value;
  after?: Value;
  afterUnknown?: boolean;
  /**
   * Some parts of `after` (object attributes, list elements) are only known after apply;
   * they read `(known after apply)` in `after`.
   */
  afterPartlyUnknown?: boolean;
  beforeSensitive?: boolean;
  afterSensitive?: boolean;
  maskedBefore?: boolean;
  maskedAfter?: boolean;
}

/** What stands for an unknown part of a partly known value. */
export const UNKNOWN_PART = '(known after apply)';

export type CheckStatus = 'pass' | 'fail' | 'error' | 'unknown';

export interface CheckInstance {
  address: string;
  status: CheckStatus;
  problems: string[];
}

export interface Check {
  /** `check.config_present`, `aws_instance.web`, `output.url`. */
  address: string;
  kind: 'check' | 'resource' | 'output_value' | string;
  status: CheckStatus;
  instances: CheckInstance[];
}

export interface Diagnostic {
  severity: 'error' | 'warning' | 'info';
  summary: string;
  detail?: string;
}

export interface Counts {
  create: number;
  update: number;
  delete: number;
  replace: number;
  read: number;
  move: number;
  import: number;
  forget: number;
  noop: number;
  drift: number;
  outputs: number;
}

export interface Unparsed {
  /** 1-based line in the cleaned text. */
  line: number;
  text: string;
}

export interface Plan {
  source: 'json' | 'text';
  flavor: 'terraform' | 'opentofu' | 'unknown';
  formatVersion?: string;
  terraformVersion?: string;
  timestamp?: string;
  /** The plan failed part way; what it holds is incomplete. */
  errored?: boolean;
  complete?: boolean;
  applyable?: boolean;
  resources: ResourceChange[];
  /** Changes made outside Terraform since the last apply (`resource_drift`). */
  drift: ResourceChange[];
  outputs: OutputChange[];
  checks: Check[];
  relevantAttributes: { resource: string; attribute: (string | number)[] }[];
  variables?: Record<string, Value>;
  diagnostics: Diagnostic[];
  /** Text plans: what couldn't be read. Empty for JSON. */
  unparsed: Unparsed[];
  /** Text plans: the `Plan: 3 to add, ...` line as written, or the "No changes." line. */
  planLine?: string;
  /** What was stripped or assumed while reading the input, for the reader to know. */
  notes: string[];
  counts: Counts;
  ms: number;
}

export const DESTRUCTIVE: ReadonlySet<Action> = new Set<Action>(['delete', 'replace']);

/** The order actions are listed in: the loud ones first. */
export const ACTION_ORDER: Record<Action, number> = { delete: 0, replace: 1, create: 2, update: 3, import: 4, move: 5, forget: 6, read: 7, 'no-op': 8 };

export const ACTION_LABEL: Record<Action, string> = {
  create: 'create',
  update: 'update',
  delete: 'destroy',
  replace: 'replace',
  read: 'read',
  'no-op': 'no change',
  move: 'move',
  import: 'import',
  forget: 'forget',
};

/** Terraform's own symbol for an action. */
export function actionSymbol(action: Action, order?: ReplaceOrder): string {
  switch (action) {
    case 'create':
      return '+';
    case 'update':
      return '~';
    case 'delete':
      return '-';
    case 'replace':
      return order === 'create-delete' ? '+/-' : '-/+';
    case 'read':
      return '<=';
    case 'move':
      return '>>';
    case 'import':
      return '<-';
    case 'forget':
      return '.';
    default:
      return ' ';
  }
}

export function emptyCounts(): Counts {
  return { create: 0, update: 0, delete: 0, replace: 0, read: 0, move: 0, import: 0, forget: 0, noop: 0, drift: 0, outputs: 0 };
}

/** The counts of a plan, from its resources. A moved resource that also changes counts for both. */
export function countPlan(resources: ResourceChange[], drift: ResourceChange[], outputs: OutputChange[]): Counts {
  const c = emptyCounts();
  for (const r of resources) {
    switch (r.action) {
      case 'create':
        c.create++;
        break;
      case 'update':
        c.update++;
        break;
      case 'delete':
        c.delete++;
        break;
      case 'replace':
        c.replace++;
        break;
      case 'read':
        c.read++;
        break;
      case 'move':
        c.move++;
        break;
      case 'import':
        c.import++;
        break;
      case 'forget':
        c.forget++;
        break;
      default:
        c.noop++;
    }
    if (r.previousAddress && r.action !== 'move') c.move++;
    if (r.importId !== undefined && r.action !== 'import') c.import++;
  }
  c.drift = drift.length;
  c.outputs = outputs.filter((o) => o.action !== 'no-op').length;
  return c;
}

/**
 * The summary line: "3 to add, 1 to change, 2 to destroy, 1 to replace". Terraform counts a
 * replacement as one add and one destroy; here it is its own number, so the line says what
 * the reviewer should look at.
 */
export function summaryLine(c: Counts): string {
  const parts = [`${c.create} to add`, `${c.update} to change`, `${c.delete} to destroy`];
  if (c.replace) parts.push(`${c.replace} to replace`);
  if (c.import) parts.push(`${c.import} to import`);
  if (c.move) parts.push(`${c.move} moved`);
  if (c.forget) parts.push(`${c.forget} to forget`);
  if (c.read) parts.push(`${c.read} to read`);
  return parts.join(', ');
}

/** Whether the plan changes anything a reviewer should look at. */
export function hasChanges(c: Counts): boolean {
  return c.create + c.update + c.delete + c.replace + c.import + c.move + c.forget + c.outputs > 0;
}

/** `module.a[0].module.b` → `["a[0]", "b"]`; the root module is `[]`. */
export function modulePath(module: string): string[] {
  if (!module) return [];
  const parts: string[] = [];
  const re = /module\.([^.[]+(?:\[[^\]]*\])?)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(module))) parts.push(m[1]);
  return parts;
}

/** Splits an address into its module part and the resource part. */
export function splitAddress(address: string): { module: string; resource: string } {
  // Everything up to the last `module.x[...]` segment.
  const re = /^((?:module\.[^.[]+(?:\[[^\]]*\])?\.)*)(.*)$/;
  const m = re.exec(address)!;
  return { module: m[1].replace(/\.$/, ''), resource: m[2] };
}

/** `aws_instance.web["x"]` → `{ mode: 'managed', type, name, index: 'x' }`. */
export function parseResourceAddress(resource: string): { mode: 'managed' | 'data'; type: string; name: string; index?: string | number } {
  let mode: 'managed' | 'data' = 'managed';
  let s = resource;
  if (s.startsWith('data.')) {
    mode = 'data';
    s = s.slice(5);
  }
  const m = /^([^.[]+)\.([^.[]+)(?:\[(.*)\])?$/.exec(s);
  if (!m) return { mode, type: s, name: '' };
  let index: string | number | undefined;
  if (m[3] !== undefined) {
    const raw = m[3];
    if (/^-?\d+$/.test(raw)) index = Number(raw);
    else if (raw.startsWith('"') && raw.endsWith('"')) {
      try {
        index = JSON.parse(raw);
      } catch {
        index = raw.slice(1, -1);
      }
    } else index = raw;
  }
  return { mode, type: m[1], name: m[2], index };
}

/** A dotted path for a child: `a.b`, `a[0]`, `a["k.ey"]` when the key needs quoting. */
export function joinPath(parent: string, key: string | number): string {
  if (typeof key === 'number') return `${parent}[${key}]`;
  if (/^[A-Za-z_][A-Za-z0-9_-]*$/.test(key)) return parent ? `${parent}.${key}` : key;
  return `${parent}[${JSON.stringify(key)}]`;
}
