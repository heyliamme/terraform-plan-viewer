// Reads the human-readable plan (`terraform plan`, `terraform show plan.tfplan`, a CI log)
// into the plan model, best effort: the text is for people, not programs, so what can't be
// read is reported rather than guessed.
import { cleanLog } from './ansi';
import { countLeaves, forcedPaths } from './diff';
import { countPlan, joinPath, parseResourceAddress, splitAddress, type Action, type Attr, type AttrKind, type Diagnostic, type OutputChange, type Plan, type ReplaceOrder, type ResourceChange, type Unparsed, type Value, UNKNOWN_PART } from './model';

type Sym = '+' | '-' | '~' | '-/+' | '+/-' | '<=' | '.' | '';

interface Line {
  /** 1-based, in the cleaned text. */
  n: number;
  indent: number;
  sym: Sym;
  /** After the symbol. */
  text: string;
  raw: string;
}

const SYMS: Sym[] = ['-/+', '+/-', '<=', '+', '-', '~', '.'];

function splitLine(raw: string, n: number): Line {
  const indent = raw.length - raw.trimStart().length;
  const t = raw.trim();
  for (const s of SYMS) {
    if (t.startsWith(s + ' ') || t === s) return { n, indent, sym: s, text: t.slice(s.length).trimStart(), raw };
  }
  return { n, indent, sym: '', text: t, raw };
}

const UNKNOWN = '(known after apply)';
const SENSITIVE = /^\(sensitive(?: value)?\)/;

interface Token {
  value?: Value;
  unknown?: boolean;
  sensitive?: boolean;
  /** A container starts here. */
  open?: '{' | '[' | 'json' | 'heredoc';
  heredoc?: string;
  /** The text could not be read as a value: kept as is. */
  raw?: string;
}

/** Go-style quoted string → value. Handles what strconv.Quote writes. */
export function unquote(s: string): { value: string; end: number } | undefined {
  if (s[0] !== '"') return undefined;
  let out = '';
  for (let i = 1; i < s.length; i++) {
    const c = s[i];
    if (c === '"') return { value: out, end: i + 1 };
    if (c !== '\\') {
      out += c;
      continue;
    }
    const e = s[++i];
    switch (e) {
      case 'n':
        out += '\n';
        break;
      case 't':
        out += '\t';
        break;
      case 'r':
        out += '\r';
        break;
      case 'a':
        out += '\x07';
        break;
      case 'b':
        out += '\b';
        break;
      case 'f':
        out += '\f';
        break;
      case 'v':
        out += '\v';
        break;
      case 'x': {
        const h = s.slice(i + 1, i + 3);
        if (/^[0-9a-fA-F]{2}$/.test(h)) {
          out += String.fromCharCode(parseInt(h, 16));
          i += 2;
        } else out += 'x';
        break;
      }
      case 'u':
      case 'U': {
        const len = e === 'u' ? 4 : 8;
        const h = s.slice(i + 1, i + 1 + len);
        if (new RegExp(`^[0-9a-fA-F]{${len}}$`).test(h)) {
          out += String.fromCodePoint(parseInt(h, 16));
          i += len;
        } else out += e;
        break;
      }
      case undefined:
        return undefined;
      default:
        out += e;
    }
  }
  return undefined;
}

const NUMBER = /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?(?=$|[,\s#)\]}])/;

function readToken(s: string): { tok: Token; rest: string } {
  s = s.trimStart();
  if (s.startsWith(UNKNOWN)) return { tok: { unknown: true }, rest: s.slice(UNKNOWN.length) };
  const sm = SENSITIVE.exec(s);
  if (sm) return { tok: { sensitive: true }, rest: s.slice(sm[0].length) };
  if (s[0] === '"') {
    const q = unquote(s);
    if (q) return { tok: { value: q.value }, rest: s.slice(q.end) };
    return { tok: { raw: s }, rest: '' };
  }
  if (s[0] === '{') return { tok: { open: '{' }, rest: s.slice(1) };
  if (s[0] === '[') return { tok: { open: '[' }, rest: s.slice(1) };
  if (s.startsWith('jsonencode(')) return { tok: { open: 'json' }, rest: s.slice('jsonencode('.length) };
  const hd = /^<<-?([A-Za-z_][A-Za-z0-9_]*)/.exec(s);
  if (hd) return { tok: { open: 'heredoc', heredoc: hd[1] }, rest: s.slice(hd[0].length) };
  if (/^null(?=$|[,\s#)\]}])/.test(s)) return { tok: { value: null }, rest: s.slice(4) };
  if (/^true(?=$|[,\s#)\]}])/.test(s)) return { tok: { value: true }, rest: s.slice(4) };
  if (/^false(?=$|[,\s#)\]}])/.test(s)) return { tok: { value: false }, rest: s.slice(5) };
  const nm = NUMBER.exec(s);
  if (nm) {
    // An integer past 2^53 keeps its digits: rounded, two different values would read the same.
    const n = Number(nm[0]);
    return { tok: { value: !Number.isSafeInteger(n) && /^-?\d+$/.test(nm[0]) ? nm[0] : n }, rest: s.slice(nm[0].length) };
  }
  // Anything else up to an arrow or a comment: kept as text.
  const end = Math.min(...[s.indexOf(' -> '), s.indexOf(' #')].filter((i) => i >= 0), s.length);
  return { tok: { raw: s.slice(0, end).replace(/,$/, '') }, rest: s.slice(end) };
}

interface Expr {
  before?: Token;
  after?: Token;
  /** `a -> b` was written. */
  arrow: boolean;
  forces: boolean;
  /** Trailing comment other than "forces replacement". */
  comment?: string;
  trailing: string;
}

function readExpr(s: string): Expr {
  const first = readToken(s);
  let rest = first.rest.trimStart();
  const e: Expr = { before: first.tok, arrow: false, forces: false, trailing: '' };
  if (rest.startsWith('->')) {
    const second = readToken(rest.slice(2));
    e.after = second.tok;
    e.arrow = true;
    rest = second.rest.trimStart();
  }
  if (rest.startsWith(',')) rest = rest.slice(1).trimStart();
  if (rest.startsWith('#')) {
    const c = rest.slice(1).trim();
    if (/^forces replacement$/.test(c)) e.forces = true;
    else e.comment = c;
    rest = '';
  }
  e.trailing = rest;
  return e;
}

/** `} -> null`, `] -> (known after apply)`, `) # forces replacement`, `},` */
interface Closer {
  char: '}' | ']' | ')';
  toNull: boolean;
  toUnknown: boolean;
  forces: boolean;
}

function readCloser(text: string): Closer | undefined {
  // Read in linear steps: one regex with several `\s*` runs next to each other backtracks
  // polynomially on a closer followed by a long run of spaces.
  const char = text[0];
  if (char !== '}' && char !== ']' && char !== ')') return undefined;
  const tail = readSuffix(text.slice(1));
  if (!tail) return undefined;
  return { char, ...tail };
}

/**
 * What may follow a closer or a heredoc marker: `,`, `-> null` or `-> (known after apply)`,
 * `,` again, `# forces replacement`, and nothing else.
 */
function readSuffix(rest: string): { toNull: boolean; toUnknown: boolean; forces: boolean } | undefined {
  let s = rest.trimStart();
  if (s.startsWith(',')) s = s.slice(1).trimStart();
  let toNull = false;
  let toUnknown = false;
  if (s.startsWith('->')) {
    s = s.slice(2).trimStart();
    if (s.startsWith('null')) {
      toNull = true;
      s = s.slice(4);
    } else if (s.startsWith(UNKNOWN)) {
      toUnknown = true;
      s = s.slice(UNKNOWN.length);
    } else return undefined;
    s = s.trimStart();
    if (s.startsWith(',')) s = s.slice(1).trimStart();
  }
  let forces = false;
  if (s.startsWith('#')) {
    if (s.slice(1).trim() !== 'forces replacement') return undefined;
    forces = true;
    s = '';
  }
  if (s.trim() !== '') return undefined;
  return { toNull, toUnknown, forces };
}

const HIDDEN = /^#\s*\((\d+) unchanged (attribute|attributes|element|elements|block|blocks) hidden\)$/;

interface Frame {
  attr: Attr;
  kind: '{' | '[' | 'json';
  /** The symbol the container was opened with: its children inherit it when they have none. */
  sym: Sym;
  /** In a list: the next element's index in the old list and in the new one. */
  bi: number;
  ai: number;
}

// The more specific phrasings first: "is tainted, so must be replaced" also ends in "must be replaced".
const HEADERS: [RegExp, (m: RegExpExecArray) => Partial<ResourceChange> & { action: Action; drift?: 'delete' | 'update' }][] = [
  [/^(.+?) is tainted, so must be replaced$/, () => ({ action: 'replace', reason: 'replace_because_tainted' })],
  [/^(.+?) will be replaced, as requested$/, () => ({ action: 'replace', reason: 'replace_by_request' })],
  [/^(.+?) will be replaced due to changes in replace_triggered_by$/, () => ({ action: 'replace', reason: 'replace_by_triggers' })],
  [/^(.+?) will be created$/, () => ({ action: 'create' })],
  [/^(.+?) will be updated in-place$/, () => ({ action: 'update' })],
  [/^(.+?) will be destroyed$/, () => ({ action: 'delete' })],
  [/^(.+?) must be replaced$/, () => ({ action: 'replace' })],
  [/^(.+?) will be read during apply$/, () => ({ action: 'read' })],
  [/^(.+?) has moved to (.+)$/, (m) => ({ action: 'move', previousAddress: m[1] })],
  [/^(.+?) will be imported$/, () => ({ action: 'import' })],
  [/^(.+?) will be removed from the (?:Terraform|OpenTofu) state but will not be destroyed$/, () => ({ action: 'forget' })],
  [/^(.+?) will no longer be managed by (?:Terraform|OpenTofu), but will not be destroyed$/, () => ({ action: 'forget' })],
  [/^(.+?) has been deleted$/, () => ({ action: 'delete', drift: 'delete' })],
  [/^(.+?) has (?:been )?changed$/, () => ({ action: 'update', drift: 'update' })],
];

const REASONS: [RegExp, string][] = [
  [/key \[.*\] is not in for_each map/, 'delete_because_each_key'],
  [/index \[\d+\] is out of range for count/, 'delete_because_count_index'],
  // A module address alone (`module.app`, `module.a["x"].module.b[0]`); a resource inside a
  // module that is still there is the no_resource_config case below.
  [/\bmodule\.[^ .[]+(?:\[[^\]]*\])?(?:\.module\.[^ .[]+(?:\[[^\]]*\])?)* is not in configuration/, 'delete_because_no_module'],
  [/\bis not in configuration/, 'delete_because_no_resource_config'],
  [/wrong repetition mode|repetition/, 'delete_because_wrong_repetition'],
  [/config refers to values not yet known/, 'read_because_config_unknown'],
  [/depends on a resource or a module with changes pending/, 'read_because_dependency_pending'],
  [/config will be reloaded to verify a check block/, 'read_because_check_nested'],
  [/moved block|no move target/, 'delete_because_no_move_target'],
];

const NOISE = /^(?:[\w.\-\[\]"]+: (?:Refreshing state|Reading|Read complete|Preparing import|Drift detected|Still reading)|Acquiring state lock|Releasing state lock|Running plan in|Waiting for|Preparing the remote plan|To perform exactly these actions|Saved the plan to|Note: You didn't use the -out option|─+$|Initializing|Terraform v|OpenTofu v|on [\w./-]+ line \d+|\$ |\+ |Running |Executing|Copying|Starting|Finished|Done\b|Using previously-installed|Installing|Downloading|Preparing|Initializing the backend|Initializing provider plugins|Initializing modules|Success!|Terraform has been successfully|OpenTofu has been successfully|Changes to Outputs:|OpenTofu used the selected providers|Terraform used the selected providers|plan\. Resource actions are indicated|\+ create|~ update in-place|- destroy|-\/\+ destroy and then create replacement|\+\/- create replacement and then destroy|<= read \(data resources\)|\. forget|OpenTofu will perform the following actions:|Terraform will perform the following actions:)/;

export function parsePlanText(input: string): Plan {
  const t0 = Date.now();
  const cleaned = cleanLog(input);
  const lines = cleaned.text.split('\n').map((raw, i) => splitLine(raw, i + 1));
  const plan: Plan = {
    source: 'text',
    flavor: /\bOpenTofu\b/.test(cleaned.text) ? 'opentofu' : /\bTerraform\b/.test(cleaned.text) ? 'terraform' : 'unknown',
    resources: [],
    drift: [],
    outputs: [],
    checks: [],
    relevantAttributes: [],
    diagnostics: [],
    unparsed: [],
    notes: cleaned.notes,
    counts: countPlan([], [], []),
    ms: 0,
  };
  const vm = /\b(?:Terraform|OpenTofu) v(\d+\.\d+\.\d+(?:-[\w.]+)?)/.exec(cleaned.text);
  if (vm) plan.terraformVersion = vm[1];

  let i = 0;
  let section: 'plan' | 'drift' = 'plan';
  /** A header seen and waiting for its resource line. */
  let pending: (Partial<ResourceChange> & { action: Action; drift?: 'delete' | 'update'; address: string }) | undefined;
  let sawPlanOrNoChanges = false;

  const unparsed = (l: Line) => {
    if (l.text) plan.unparsed.push({ line: l.n, text: l.raw.trim() });
  };

  while (i < lines.length) {
    const l = lines[i];
    const t = l.text;
    if (!t) {
      i++;
      continue;
    }
    // Section markers.
    if (/Objects have changed outside of (?:Terraform|OpenTofu)/.test(t)) {
      section = 'drift';
      i++;
      continue;
    }
    if (/^(?:Terraform|OpenTofu) will perform the following actions:/.test(t) || /^(?:Terraform|OpenTofu) used the selected providers/.test(t)) {
      section = 'plan';
      i++;
      continue;
    }
    const planLine = /^Plan: (.+)$/.exec(t);
    if (planLine && l.sym === '') {
      plan.planLine = t;
      sawPlanOrNoChanges = true;
      i++;
      continue;
    }
    if (/^No changes\. (?:Your infrastructure (?:still )?matches the configuration|No objects need to be destroyed)/.test(t)) {
      plan.planLine = t;
      sawPlanOrNoChanges = true;
      i++;
      continue;
    }
    if (/^Changes to Outputs:/.test(t)) {
      i = readOutputs(lines, i + 1, plan);
      continue;
    }
    const diag = /^(?:│\s*)?(Warning|Error):\s*(.+)$/.exec(t);
    if (diag && l.sym === '') {
      i = readDiagnostic(lines, i, plan, diag[1] === 'Error' ? 'error' : 'warning', diag[2]);
      continue;
    }
    // A resource header: "# addr will be created", then "# (reason)" lines.
    if (l.sym === '' && t.startsWith('# ')) {
      const body = t.slice(2).trim();
      const header = matchHeader(body);
      if (header) {
        pending = header;
        i++;
        while (i < lines.length && lines[i].sym === '' && /^# \(/.test(lines[i].text)) {
          applyReason(pending, lines[i].text.slice(2).trim());
          i++;
        }
        continue;
      }
      if (/^# \(/.test(t) && pending) {
        applyReason(pending, t.slice(2).trim());
        i++;
        continue;
      }
      if (/^# /.test(t) && /\b(will be|must be|has moved|has been|is tainted)\b/.test(t)) {
        plan.unparsed.push({ line: l.n, text: l.raw.trim() });
        plan.notes.push(`Line ${l.n} looks like a resource header this version doesn't know: ${body}`);
      }
      i++;
      continue;
    }
    // The resource line.
    const res = /^(resource|data) "([^"]+)" "([^"]+)" \{\s*(#.*)?$/.exec(t);
    if (res) {
      const rc = startResource(res, l.sym, pending);
      pending = undefined;
      i = readBody(lines, i + 1, rc, plan);
      finishResource(rc);
      if (section === 'drift' || rc.drift) plan.drift.push(rc.rc);
      else plan.resources.push(rc.rc);
      continue;
    }
    if (l.sym !== '' && !NOISE.test(l.raw.trim())) unparsed(l);
    i++;
  }

  plan.counts = countPlan(plan.resources, plan.drift, plan.outputs);
  if (!sawPlanOrNoChanges && plan.resources.length === 0 && plan.drift.length === 0 && plan.outputs.length === 0) {
    plan.notes.push('No plan was found in the text: no "Plan:" line, no "No changes." line and no resource changes.');
  }
  if (plan.planLine) checkPlanLine(plan);
  if (plan.unparsed.length) plan.notes.push(`${plan.unparsed.length} line${plan.unparsed.length === 1 ? '' : 's'} could not be read; see "Could not read" below.`);
  plan.ms = Date.now() - t0;
  return plan;
}

function matchHeader(body: string): (Partial<ResourceChange> & { action: Action; drift?: 'delete' | 'update'; address: string }) | undefined {
  for (const [re, make] of HEADERS) {
    const m = re.exec(body);
    if (!m) continue;
    let address = m[1];
    const partial = make(m);
    const out = { ...partial, address } as Partial<ResourceChange> & { action: Action; drift?: 'delete' | 'update'; address: string };
    if (partial.action === 'move') out.address = m[2];
    const dep = /^(.+?) \(deposed object ([0-9a-f]+)\)$/.exec(out.address);
    if (dep) {
      out.address = dep[1];
      out.deposed = dep[2];
      address = dep[1];
    }
    return out;
  }
  return undefined;
}

function applyReason(p: Partial<ResourceChange>, text: string) {
  const imp = /^\(imported from "(.*)"\)$/.exec(text);
  if (imp) {
    p.importId = unquote(`"${imp[1]}"`)?.value ?? imp[1];
    return;
  }
  const mv = /^\(moved from (.+)\)$/.exec(text);
  if (mv) {
    p.previousAddress = mv[1];
    return;
  }
  const inner = text.replace(/^\(/, '').replace(/\)$/, '').replace(/^because /, '');
  for (const [re, code] of REASONS) {
    if (re.test(inner)) {
      p.reason = code;
      return;
    }
  }
  p.reason = inner;
}

interface Building {
  rc: ResourceChange;
  drift?: 'delete' | 'update';
}

function startResource(res: RegExpExecArray, sym: Sym, pending: (Partial<ResourceChange> & { action: Action; drift?: 'delete' | 'update'; address: string }) | undefined): Building {
  const mode = res[1] === 'data' ? 'data' : 'managed';
  const type = res[2];
  const name = res[3];
  let action: Action = pending?.action ?? symAction(sym, mode);
  let replaceOrder: ReplaceOrder | undefined;
  if (sym === '-/+') replaceOrder = 'delete-create';
  else if (sym === '+/-') replaceOrder = 'create-delete';
  if (action === 'replace' && !replaceOrder) replaceOrder = 'delete-create';
  if (sym === '.' && !pending) action = 'forget';
  const address = pending?.address ?? `${mode === 'data' ? 'data.' : ''}${type}.${name}`;
  const split = splitAddress(address);
  const parsed = parseResourceAddress(split.resource);
  const rc: ResourceChange = {
    address,
    module: split.module,
    mode,
    type,
    name,
    action,
    actions: actionsOf(action, replaceOrder),
    attrs: [],
    forces: [],
    changedKeys: [],
    n: { add: 0, change: 0, remove: 0, same: 0 },
  };
  if (replaceOrder) rc.replaceOrder = replaceOrder;
  if (parsed.index !== undefined) rc.index = parsed.index;
  if (pending?.previousAddress) rc.previousAddress = pending.previousAddress;
  if (pending?.reason) rc.reason = pending.reason;
  if (pending?.importId !== undefined) rc.importId = pending.importId;
  if (pending?.deposed) rc.deposed = pending.deposed;
  return { rc, drift: pending?.drift };
}

function symAction(sym: Sym, mode: 'managed' | 'data'): Action {
  switch (sym) {
    case '+':
      return 'create';
    case '-':
      return 'delete';
    case '~':
      return 'update';
    case '-/+':
    case '+/-':
      return 'replace';
    case '<=':
      return 'read';
    case '.':
      return 'forget';
    default:
      return mode === 'data' ? 'read' : 'no-op';
  }
}

export function actionsOf(action: Action, order?: ReplaceOrder): string[] {
  switch (action) {
    case 'replace':
      return order === 'create-delete' ? ['create', 'delete'] : ['delete', 'create'];
    case 'move':
    case 'import':
      return ['no-op'];
    default:
      return [action];
  }
}

function finishResource(b: Building) {
  const rc = b.rc;
  indexRepeatedBlocks(rc.attrs);
  rc.n = countLeaves(rc.attrs);
  rc.forces = forcedPaths(rc.attrs);
  rc.changedKeys = [...new Set(rc.attrs.filter((a) => a.kind !== 'same').map((a) => a.key))];
}

/**
 * Repeated nested blocks (`- ingress { }`, `+ ingress { }`) all read as `ingress`: give them
 * indexed paths, `ingress[0]`, `ingress[1]`, as the JSON reading does, so each path names
 * one value. A block that appears once keeps its plain path.
 */
function indexRepeatedBlocks(attrs: Attr[]) {
  const seen = new Map<string, number>();
  for (const a of attrs) if (a.block) seen.set(a.key, (seen.get(a.key) ?? 0) + 1);
  const next = new Map<string, number>();
  for (const a of attrs) {
    if (a.block && (seen.get(a.key) ?? 0) > 1) {
      const n = next.get(a.key) ?? 0;
      next.set(a.key, n + 1);
      repath(a, a.path, `${a.path}[${n}]`);
    }
    if (a.children) indexRepeatedBlocks(a.children);
  }
}

function repath(a: Attr, from: string, to: string) {
  if (a.path === from || a.path.startsWith(from + '.') || a.path.startsWith(from + '[')) a.path = to + a.path.slice(from.length);
  for (const c of a.children ?? []) repath(c, from, to);
}

/** Reads the body of a resource block up to its closing brace. Returns the next line index. */
function readBody(lines: Line[], i: number, b: Building, plan: Plan): number {
  const rc = b.rc;
  const root: Attr = { key: '', path: '', kind: 'same', children: [] };
  const stack: Frame[] = [{ attr: root, kind: '{', sym: '', bi: 0, ai: 0 }];
  const bad: string[] = [];
  const done = (next: number) => {
    rc.attrs = root.children!;
    if (bad.length) {
      rc.unparsed = bad;
      for (const x of bad) plan.unparsed.push({ line: Number(x.split(':')[0]), text: x.slice(x.indexOf(':') + 2) });
    }
    return next;
  };
  while (i < lines.length) {
    const l = lines[i];
    const t = l.text;
    if (!t) {
      i++;
      continue;
    }
    const frame = stack[stack.length - 1];
    // Another resource starts before this one closed: the braces didn't add up (a
    // truncated or edited log). End here and let the caller read it.
    if ((l.sym !== '' || l.indent <= 4) && /^(?:resource|data) "[^"]+" "[^"]+" \{/.test(t)) {
      bad.push(`${l.n}: the block for ${rc.address} ends before its closing brace`);
      return done(i);
    }
    if (l.sym === '' && l.indent <= 2 && t.startsWith('# ') && matchHeader(t.slice(2).trim())) {
      bad.push(`${l.n}: the block for ${rc.address} ends before its closing brace`);
      return done(i);
    }
    // Hidden-children comment.
    const hid = HIDDEN.exec(t);
    if (hid && l.sym === '') {
      frame.attr.hidden = (frame.attr.hidden ?? 0) + Number(hid[1]);
      // Elided list elements still take their places: the indices after them stay right.
      if (frame.kind === '[' && /^elements?$/.test(hid[2])) {
        frame.bi += Number(hid[1]);
        frame.ai += Number(hid[1]);
      }
      i++;
      continue;
    }
    // A closer.
    const closer = readCloser(t);
    if (closer && (l.sym === '' || l.sym === '-' || l.sym === '+' || l.sym === '~')) {
      if (stack.length === 1) {
        // The resource's own closing brace.
        return done(i + 1);
      }
      const f = stack.pop()!;
      if (f.kind === 'json' && f.attr.children?.length === 1 && f.attr.children[0].key === '') {
        // jsonencode( { ... } ): fold the single unnamed object into the attribute itself,
        // before anything below reads the children.
        const inner = f.attr.children[0];
        f.attr.children = inner.children;
        if (inner.hidden) f.attr.hidden = inner.hidden;
        if (inner.forcesReplacement) f.attr.forcesReplacement = true;
        if (inner.kind !== 'same' && f.attr.kind === 'same') f.attr.kind = inner.kind;
        if (inner.afterUnknown) f.attr.afterUnknown = true;
      }
      if (closer.toNull) {
        f.attr.kind = 'remove';
      } else if (closer.toUnknown) {
        // `{ ... } -> (known after apply)`: the whole value becomes unknown. One leaf, with
        // the old value, as the JSON reading has it (for jsonencode, the JSON string).
        f.attr.kind = 'change';
        f.attr.afterUnknown = true;
        const v = treeValue(f.attr);
        if (v.before !== undefined) f.attr.before = f.kind === 'json' && typeof v.before === 'object' && v.before !== null ? JSON.stringify(v.before) : v.before;
        delete f.attr.children;
      }
      if (closer.forces) f.attr.forcesReplacement = true;
      if (f.kind === 'json' && f.attr.children) f.attr.encoded = 'json';
      settleContainer(f.attr);
      i++;
      continue;
    }
    if (l.sym === '' && t.startsWith('#')) {
      // Other comments inside a body ("# (n unchanged ...)" handled above).
      i++;
      continue;
    }
    // An attribute, a nested block, or a list element. Inside an added or removed
    // container every line is added or removed too; inside a changed one, a line with no
    // symbol is unchanged.
    const sym: Sym = l.sym || (frame.sym === '+' || frame.sym === '-' ? frame.sym : '');
    const kv = /^("(?:[^"\\]|\\.)*"|[A-Za-z_][\w.-]*)\s+=\s+(.*)$/.exec(t);
    const block = /^([A-Za-z_][\w-]*)(?:\s+"[^"]*")*\s*\{\s*(#.*)?$/.exec(t);
    let key: string;
    let rest: string;
    let isBlock = false;
    if (kv) {
      key = kv[1].startsWith('"') ? (unquote(kv[1])?.value ?? kv[1]) : kv[1];
      rest = kv[2];
    } else if (block && frame.kind !== '[') {
      key = block[1];
      rest = `{${block[2] ? ' ' + block[2] : ''}`;
      isBlock = true;
    } else if (frame.kind === '[' || frame.kind === 'json') {
      key = '';
      rest = t;
    } else {
      bad.push(`${l.n}: ${l.raw.trim()}`);
      i++;
      continue;
    }
    const e = readExpr(rest);
    // Inside `jsonencode( ... )` the one unnamed object stands for the attribute itself.
    const inJson = frame.kind === 'json' && !kv;
    let path = inJson ? frame.attr.path : joinPath(frame.attr.path, key);
    if (inJson) key = '';
    else if (frame.kind === '[') {
      // List elements go by their index in the new list, as in the JSON reading; one removed
      // from a list that stays goes by its old index, marked (`[was 1]`).
      const removed = sym === '-' && frame.sym !== '-';
      const k = removed || frame.sym === '-' ? frame.bi : frame.ai;
      key = `[${k}]`;
      path = removed ? `${frame.attr.path}[was ${k}]` : joinPath(frame.attr.path, k);
      if (sym !== '+') frame.bi++;
      if (sym !== '-') frame.ai++;
    }
    const attr: Attr = { key, path, kind: 'same' };
    if (isBlock) attr.block = true;
    const tok = e.before;
    // `tags = {}`, `- list = [] -> null`: an empty container on one line is a leaf.
    const emptyClose = tok?.open && tok.open !== 'heredoc' ? readCloser(e.trailing) : undefined;
    if (tok?.open && emptyClose && (tok.open === '[' ? emptyClose.char === ']' : tok.open === '{' ? emptyClose.char === '}' : emptyClose.char === ')')) {
      const empty: Value = tok.open === '[' ? [] : {};
      applyLeaf(attr, sym, { before: { value: empty }, after: emptyClose.toNull ? { value: null } : emptyClose.toUnknown ? { unknown: true } : undefined, arrow: emptyClose.toNull || emptyClose.toUnknown, forces: e.forces || emptyClose.forces, trailing: '' }, bad, l);
      if (emptyClose.toNull) {
        attr.kind = 'remove';
        delete attr.after;
      }
      frame.attr.children!.push(attr);
      i++;
      continue;
    }
    if (tok?.open) {
      stack.push({ attr, kind: tok.open === 'heredoc' ? '{' : tok.open, sym, bi: 0, ai: 0 });
      frame.attr.children!.push(attr);
      if (tok.open === 'heredoc') {
        stack.pop();
        i = readHeredoc(lines, i + 1, tok.heredoc!, sym, attr);
        if (e.forces) attr.forcesReplacement = true;
        continue;
      }
      attr.children = [];
      attr.kind = sym === '+' ? 'add' : sym === '-' ? 'remove' : sym === '~' ? 'change' : 'same';
      if (e.forces) attr.forcesReplacement = true;
      i++;
      continue;
    }
    applyLeaf(attr, sym, e, bad, l);
    frame.attr.children!.push(attr);
    i++;
  }
  // Ran out of text before the closing brace: a truncated log. Keep what was read.
  bad.push(`${lines[lines.length - 1]?.n ?? 0}: the block for ${rc.address} ends before its closing brace (truncated?)`);
  return done(i);
}

function applyLeaf(attr: Attr, sym: Sym, e: Expr, bad: string[], l: Line) {
  const b = e.before;
  const a = e.after;
  const val = (t: Token | undefined): Value | undefined => (t && 'value' in t ? t.value : undefined);
  if (b?.raw !== undefined || a?.raw !== undefined) bad.push(`${l.n}: ${l.raw.trim()}`);
  switch (sym) {
    case '+':
      attr.kind = 'add';
      if (b?.unknown) attr.afterUnknown = true;
      else if (b?.sensitive) attr.afterSensitive = true;
      else attr.after = val(b);
      break;
    case '-':
      attr.kind = 'remove';
      if (b?.sensitive) attr.beforeSensitive = true;
      else attr.before = val(b);
      break;
    case '~':
      attr.kind = 'change';
      if (b?.sensitive && !e.arrow) {
        // "~ x = (sensitive value)": both sides sensitive, neither shown.
        attr.beforeSensitive = true;
        attr.afterSensitive = true;
      } else {
        if (b?.sensitive) attr.beforeSensitive = true;
        else attr.before = val(b);
        if (a?.unknown) attr.afterUnknown = true;
        else if (a?.sensitive) attr.afterSensitive = true;
        else if (a) attr.after = val(a);
      }
      break;
    default:
      attr.kind = 'same';
      if (b?.sensitive) {
        attr.beforeSensitive = true;
        attr.afterSensitive = true;
      } else if (b?.unknown) attr.afterUnknown = true;
      else {
        attr.before = val(b);
        attr.after = val(b);
      }
  }
  if (e.forces) attr.forcesReplacement = true;
  if (b?.raw !== undefined) attr.before = b.raw;
  if (a?.raw !== undefined) attr.after = a.raw;
}

/** The kind of a container from its children, when its own symbol said nothing. */
function settleContainer(attr: Attr) {
  if (attr.kind !== 'same' || !attr.children) return;
  const kinds = new Set(attr.children.map((c) => c.kind));
  if (kinds.size === 1 && !attr.hidden) {
    const k = [...kinds][0] as AttrKind;
    if (k === 'add' || k === 'remove') attr.kind = k;
    else if (k === 'change') attr.kind = 'change';
  } else if (kinds.size > 1 || (kinds.size === 1 && !kinds.has('same'))) attr.kind = 'change';
}

/**
 * A `<<-EOT` string: lines up to the marker. With `~`, the body is a line diff. A removed or
 * now-unknown string ends `EOT -> null` / `EOT -> (known after apply)`.
 */
function readHeredoc(lines: Line[], i: number, marker: string, sym: Sym, attr: Attr): number {
  const body: string[] = [];
  let end: ReturnType<typeof readSuffix>;
  while (i < lines.length) {
    const t = lines[i].raw.trim();
    if (t.startsWith(marker) && (end = readSuffix(t.slice(marker.length)))) break;
    body.push(lines[i].raw);
    i++;
  }
  const indents = body.filter((x) => x.trim()).map((x) => x.length - x.trimStart().length);
  const base = indents.length ? Math.min(...indents) : 0;
  if (sym === '~') {
    const before: string[] = [];
    const after: string[] = [];
    for (const raw of body) {
      const s = raw.slice(base);
      // An added or removed empty line is a bare `+` / `-`: trailing spaces were trimmed.
      if (s.startsWith('- ') || s === '-') before.push(s.slice(2));
      else if (s.startsWith('+ ') || s === '+') after.push(s.slice(2));
      else {
        const u = s.startsWith('  ') ? s.slice(2) : s;
        // Terraform's elision, not a line of the string: counted, never read as content.
        const elided = /^#\s*\((\d+) unchanged lines? hidden\)$/.exec(u.trim());
        if (elided) {
          attr.hidden = (attr.hidden ?? 0) + Number(elided[1]);
          continue;
        }
        before.push(u);
        after.push(u);
      }
    }
    attr.kind = 'change';
    attr.before = before.join('\n');
    attr.after = after.join('\n');
  } else {
    const text = body.map((raw) => raw.slice(base)).join('\n');
    attr.kind = sym === '+' ? 'add' : sym === '-' ? 'remove' : 'same';
    if (sym !== '+') attr.before = text;
    if (sym !== '-') attr.after = text;
  }
  // Terraform writes the body with a trailing newline.
  if (typeof attr.before === 'string') attr.before += '\n';
  if (typeof attr.after === 'string') attr.after += '\n';
  if (end?.toNull) {
    attr.kind = 'remove';
    delete attr.after;
  } else if (end?.toUnknown) {
    attr.kind = 'change';
    attr.afterUnknown = true;
    delete attr.after;
  }
  if (end?.forces) attr.forcesReplacement = true;
  // Past the marker line.
  return i + 1;
}

/** "Changes to Outputs:" block. */
function readOutputs(lines: Line[], i: number, plan: Plan): number {
  const root: Attr = { key: '', path: '', kind: 'same', children: [] };
  const fake: Building = { rc: { address: 'outputs', module: '', mode: 'managed', type: '', name: '', action: 'update', actions: [], attrs: [], forces: [], changedKeys: [], n: { add: 0, change: 0, remove: 0, same: 0 } } };
  // Reuse the body reader by pretending the outputs are a resource body ending at a blank
  // line followed by something that is not an output line.
  const sub: Line[] = [];
  let j = i;
  while (j < lines.length) {
    const l = lines[j];
    if (!l.text) {
      // Outputs end at a blank line followed by a line that isn't indented.
      const next = lines[j + 1];
      if (!next || next.indent === 0) break;
      sub.push(l);
      j++;
      continue;
    }
    if (l.indent === 0 && !/^[}\])]/.test(l.text)) break;
    sub.push(l);
    j++;
  }
  sub.push({ n: 0, indent: 0, sym: '', text: '}', raw: '}' });
  readBody(sub, 0, fake, plan);
  void root;
  for (const a of fake.rc.attrs) {
    const o: OutputChange = { name: a.key, action: a.kind === 'add' ? 'create' : a.kind === 'remove' ? 'delete' : a.kind === 'change' ? 'update' : 'no-op' };
    if (a.before !== undefined) o.before = a.before;
    if (a.after !== undefined) o.after = a.after;
    if (a.children && a.before === undefined && a.after === undefined) {
      const v = treeValue(a, true);
      if (v.before !== undefined) o.before = v.before;
      if (v.after !== undefined) o.after = v.after;
      if (v.partlyUnknown && o.action !== 'delete') o.afterPartlyUnknown = true;
    }
    if (a.afterUnknown) o.afterUnknown = true;
    if (a.beforeSensitive) o.beforeSensitive = true;
    if (a.afterSensitive) o.afterSensitive = true;
    plan.outputs.push(o);
  }
  return j;
}

/** Rebuilds the before and after values of a container from its children. */
export function treeValue(a: Attr, markUnknown = false): { before?: Value; after?: Value; partlyUnknown?: boolean } {
  if (!a.children) return { before: a.before, after: markUnknown && a.afterUnknown && a.kind !== 'remove' ? UNKNOWN_PART : a.after, partlyUnknown: markUnknown && a.afterUnknown && a.kind !== 'remove' };
  const isList = a.children.every((c) => /^\[\d+\]$/.test(c.key));
  const before: Value[] | { [k: string]: Value } = isList ? [] : {};
  const after: Value[] | { [k: string]: Value } = isList ? [] : {};
  let hasB = false;
  let hasA = false;
  let partlyUnknown = false;
  for (const c of a.children) {
    const v = treeValue(c, markUnknown);
    if (v.partlyUnknown) partlyUnknown = true;
    if (v.before !== undefined && c.kind !== 'add') {
      hasB = true;
      if (Array.isArray(before)) before.push(v.before);
      else before[c.key] = v.before;
    }
    if (v.after !== undefined && c.kind !== 'remove') {
      hasA = true;
      if (Array.isArray(after)) after.push(v.after);
      else after[c.key] = v.after;
    }
  }
  return { before: hasB || a.kind === 'remove' || a.kind === 'change' || a.kind === 'same' ? before : undefined, after: hasA || a.kind === 'add' || a.kind === 'change' || a.kind === 'same' ? after : undefined, partlyUnknown };
}

function readDiagnostic(lines: Line[], i: number, plan: Plan, severity: Diagnostic['severity'], summary: string): number {
  const detail: string[] = [];
  i++;
  let blank = 0;
  while (i < lines.length) {
    const l = lines[i];
    const t = l.raw.replace(/^\s*│\s?/, '').replace(/^\s*╵\s*$/, '').trimEnd();
    if (/^\s*(?:│\s*)?(?:Warning|Error):/.test(l.raw) || /^Plan: /.test(l.text) || /^Changes to Outputs:/.test(l.text) || /^(?:Terraform|OpenTofu) will perform/.test(l.text)) break;
    if (!t.trim()) {
      blank++;
      if (blank >= 2 && detail.length) break;
      if (detail.length) detail.push('');
      i++;
      continue;
    }
    blank = 0;
    if (/^\s*╷\s*$/.test(l.raw)) {
      i++;
      continue;
    }
    detail.push(t.trim());
    i++;
  }
  while (detail.length && !detail[detail.length - 1]) detail.pop();
  const d: Diagnostic = { severity, summary: summary.trim() };
  if (detail.length) d.detail = detail.join('\n');
  plan.diagnostics.push(d);
  return i;
}

/** The "Plan:" line against what was read: a mismatch means something wasn't understood. */
function checkPlanLine(plan: Plan) {
  const m = plan.planLine && /^Plan: (.+)\.$/.exec(plan.planLine);
  if (!m) return;
  const said: Record<string, number> = {};
  for (const part of m[1].split(', ')) {
    const x = /^(\d+) to (\w+)$/.exec(part.trim());
    if (x) said[x[2]] = Number(x[1]);
  }
  const c = plan.counts;
  const have = { add: c.create + c.replace, change: c.update, destroy: c.delete + c.replace, import: c.import, forget: c.forget };
  const diff: string[] = [];
  for (const [k, v] of Object.entries(said)) if (k in have && have[k as keyof typeof have] !== v) diff.push(`${k}: the line says ${v}, ${have[k as keyof typeof have]} read`);
  if (diff.length) plan.notes.push(`The plan line and the resources read don't agree (${diff.join('; ')}): part of the text may be missing or unreadable.`);
}
