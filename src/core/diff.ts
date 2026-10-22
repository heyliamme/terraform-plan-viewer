// The before/after of one resource as a tree of attribute changes, from the plan JSON's
// `change` object: `before`, `after`, `after_unknown`, `before_sensitive`, `after_sensitive`
// and `replace_paths`, each of which mirrors the value's shape.
import { joinPath, UNKNOWN_PART, type Attr, type AttrKind, type Value } from './model';

const isObj = (v: unknown): v is { [k: string]: Value } => v !== null && typeof v === 'object' && !Array.isArray(v);

export function equal(a: Value | undefined, b: Value | undefined): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!equal(a[i], b[i])) return false;
    return true;
  }
  if (Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (!(k in (b as object)) || !equal(a[k], (b as { [k: string]: Value })[k])) return false;
  return true;
}

/** A mirror structure (`after_unknown`, `*_sensitive`) looked up at a key. `true` covers everything below. */
function at(mirror: unknown, key: string | number): unknown {
  if (mirror === true) return true;
  if (mirror === null || typeof mirror !== 'object') return undefined;
  if (Array.isArray(mirror)) return typeof key === 'number' ? mirror[key] : undefined;
  return (mirror as Record<string, unknown>)[String(key)];
}

/** Whether a mirror structure marks anything at or under it. */
export function anyTrue(mirror: unknown): boolean {
  if (mirror === true) return true;
  if (mirror === null || typeof mirror !== 'object') return false;
  for (const v of Array.isArray(mirror) ? mirror : Object.values(mirror)) if (anyTrue(v)) return true;
  return false;
}

/**
 * A value with its unknown parts (from an `after_unknown` mirror) filled in with
 * UNKNOWN_PART: Terraform leaves unknown attributes out and writes unknown list elements
 * as null.
 */
export function withUnknownParts(v: Value | undefined, unk: unknown): Value {
  if (unk === true) return UNKNOWN_PART;
  if (Array.isArray(unk)) {
    const list = Array.isArray(v) ? [...v] : [];
    unk.forEach((u, i) => {
      if (anyTrue(u)) list[i] = withUnknownParts(list[i], u);
    });
    for (let i = 0; i < list.length; i++) if (list[i] === undefined) list[i] = null;
    return list;
  }
  if (unk !== null && typeof unk === 'object') {
    const obj: { [k: string]: Value } = v !== null && typeof v === 'object' && !Array.isArray(v) ? { ...v } : {};
    for (const [k, u] of Object.entries(unk)) if (anyTrue(u)) obj[k] = withUnknownParts(obj[k], u);
    return obj;
  }
  return v ?? null;
}

/** Whether a string holds a JSON object or array (a `jsonencode()` value). */
export function parseEncodedJson(s: string): Value | undefined {
  const t = s.trim();
  if (!(t.startsWith('{') && t.endsWith('}')) && !(t.startsWith('[') && t.endsWith(']'))) return undefined;
  try {
    const v = JSON.parse(t);
    return v !== null && typeof v === 'object' ? v : undefined;
  } catch {
    return undefined;
  }
}

export interface DiffInput {
  before?: Value;
  after?: Value;
  afterUnknown?: unknown;
  beforeSensitive?: unknown;
  afterSensitive?: unknown;
  replacePaths?: (string | number)[][];
}

/** A value written out with object keys sorted: two values are equal when these are. */
function canonical(v: Value | undefined): string {
  if (v === undefined) return 'u';
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  return `{${Object.keys(v)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
    .join(',')}}`;
}

/** Above this many pairs lists are aligned by position instead of by content. */
const LCS_LIMIT = 4_000_000;

/**
 * Pairs the elements of two lists: equal elements stay matched across insertions and
 * removals (the longest common subsequence), and what is left between matches pairs up by
 * position, so an edited element shows as a change rather than a removal and an addition.
 */
export function alignLists(b: Value[], a: Value[]): [number | undefined, number | undefined][] {
  const out: [number | undefined, number | undefined][] = [];
  if (b.length * a.length > LCS_LIMIT) {
    const n = Math.max(b.length, a.length);
    for (let i = 0; i < n; i++) out.push([i < b.length ? i : undefined, i < a.length ? i : undefined]);
    return out;
  }
  // Classic LCS, O(n*m) over element ids: each element is written out once and equal
  // elements share an id, so a cell costs the same however big the elements are.
  const n = b.length;
  const m = a.length;
  const ids = new Map<string, number>();
  const idOf = (v: Value) => {
    const k = canonical(v);
    let id = ids.get(k);
    if (id === undefined) ids.set(k, (id = ids.size));
    return id;
  };
  const ib = b.map(idOf);
  const ia = a.map(idOf);
  const dp: Uint32Array[] = [];
  for (let i = 0; i <= n; i++) dp.push(new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--) dp[i][j] = ib[i] === ia[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  let i = 0;
  let j = 0;
  const pendingB: number[] = [];
  const pendingA: number[] = [];
  const flush = () => {
    const k = Math.max(pendingB.length, pendingA.length);
    for (let x = 0; x < k; x++) out.push([pendingB[x], pendingA[x]]);
    pendingB.length = 0;
    pendingA.length = 0;
  };
  while (i < n && j < m) {
    if (ib[i] === ia[j]) {
      flush();
      out.push([i++, j++]);
    } else if (dp[i + 1][j] >= dp[i][j + 1]) pendingB.push(i++);
    else pendingA.push(j++);
  }
  while (i < n) pendingB.push(i++);
  while (j < m) pendingA.push(j++);
  flush();
  return out;
}

/** The attribute tree of a change. The resource-level `actions` decide what an absent side means. */
export function diffChange(input: DiffInput): Attr[] {
  const forces = new Set<string>();
  for (const p of input.replacePaths ?? []) {
    let path = '';
    for (const k of p) path = joinPath(path, k);
    forces.add(path);
  }
  const root = diffValue('', '', input.before, input.after, input.afterUnknown, input.beforeSensitive, input.afterSensitive, forces);
  return root.children ?? [];
}

function diffValue(key: string, path: string, b: Value | undefined, a: Value | undefined, unk: unknown, bs: unknown, as: unknown, forces: Set<string>): Attr {
  const attr: Attr = { key, path, kind: 'same' };
  if (bs === true) attr.beforeSensitive = true;
  if (as === true) attr.afterSensitive = true;
  if (forces.has(path)) attr.forcesReplacement = true;
  const unknown = unk === true;
  if (unknown) attr.afterUnknown = true;

  // Containers on both sides: compare inside.
  if (isObj(b) && (isObj(a) || (a === undefined && unknown && isObj(unk)))) {
    const ao = isObj(a) ? a : {};
    const keys = [...new Set([...Object.keys(b), ...Object.keys(ao), ...(isObj(unk) ? Object.keys(unk) : [])])].sort();
    attr.children = keys.map((k) => diffValue(k, joinPath(path, k), b[k], ao[k], at(unk, k), at(bs, k), at(as, k), forces));
    attr.kind = kindOfChildren(attr.children);
    if (attr.children.length === 0 && (unknown || !equal(b, a))) attr.kind = 'change';
    if (unknown && isObj(unk)) attr.afterUnknown = false; // partly unknown: the children say which
    return finish(attr, b, a);
  }
  if (Array.isArray(b) && Array.isArray(a)) {
    attr.children = [];
    const pairs = alignLists(b, a);
    let idx = 0;
    for (const [bi, ai] of pairs) {
      const bv = bi === undefined ? undefined : b[bi];
      const av = ai === undefined ? undefined : a[ai];
      // Kept and added elements go by their index in the new list. A removed one goes by its
      // old index, marked, so no two elements share a path (paths key reveals and compares).
      const k = ai ?? bi ?? idx;
      const p = ai === undefined && bi !== undefined ? `${path}[was ${bi}]` : joinPath(path, k);
      attr.children.push(diffValue(`[${k}]`, p, bv, av, ai === undefined ? undefined : at(unk, ai), bi === undefined ? undefined : at(bs, bi), ai === undefined ? undefined : at(as, ai), forces));
      idx++;
    }
    attr.kind = kindOfChildren(attr.children);
    return finish(attr, b, a);
  }
  // One side only: an added or removed container is listed with its leaves. An added
  // object may have attributes only in `after_unknown` (ids, computed hashes). A null on the
  // other side counts as absent, as in Terraform's output (`+ sg = [ + (known after apply) ]`).
  const afterIsContainer = isObj(a) || Array.isArray(a) || (a === undefined && (isObj(unk) || Array.isArray(unk)));
  if ((b === undefined || (b === null && afterIsContainer)) && !unknown && afterIsContainer) {
    attr.kind = 'add';
    attr.children = leaves(a ?? (Array.isArray(unk) ? [] : {}), path, 'add', as, forces, unk);
    return finish(attr, b, a);
  }
  if ((a === undefined || a === null) && !unknown && (isObj(b) || Array.isArray(b))) {
    attr.kind = 'remove';
    attr.children = leaves(b, path, 'remove', bs, forces);
    return finish(attr, b, a);
  }
  // A string holding JSON: shown as the JSON inside it, as Terraform's own output does.
  if (typeof b === 'string' && typeof a === 'string' && b !== a && !attr.beforeSensitive && !attr.afterSensitive) {
    const bj = parseEncodedJson(b);
    const aj = bj === undefined ? undefined : parseEncodedJson(a);
    if (bj !== undefined && aj !== undefined) {
      const inner = diffValue(key, path, bj, aj, undefined, undefined, undefined, forces);
      // The same JSON written differently (key order, whitespace) is still a change: it is
      // shown as the two strings rather than as an inner diff with nothing in it.
      if (inner.kind !== 'same') {
        inner.encoded = 'json';
        inner.before = b;
        inner.after = a;
        if (attr.forcesReplacement) inner.forcesReplacement = true;
        return inner;
      }
    }
  }
  // A leaf holding a whole container (one side null or another type): masked whole when
  // anything inside it is sensitive, since its children are never listed on their own.
  if (!attr.beforeSensitive && b !== null && typeof b === 'object' && anyTrue(bs)) attr.beforeSensitive = true;
  if (!attr.afterSensitive && a !== null && typeof a === 'object' && anyTrue(as)) attr.afterSensitive = true;
  // Leaves. An attribute created as null, or removed while null, is not a change worth
  // showing: Terraform's own output leaves them out.
  if (unknown) attr.kind = b === undefined ? 'add' : 'change';
  else if (b === undefined && a === undefined) attr.kind = 'same';
  else if (b === undefined) attr.kind = a === null ? 'same' : 'add';
  else if (a === undefined) attr.kind = b === null ? 'same' : 'remove';
  else attr.kind = equal(b, a) ? 'same' : 'change';
  // A created or removed string holding JSON: opened up, as the text output does.
  if ((attr.kind === 'add' || attr.kind === 'remove') && !attr.beforeSensitive && !attr.afterSensitive) {
    const v = attr.kind === 'add' ? a : b;
    const parsed = typeof v === 'string' ? parseEncodedJson(v) : undefined;
    if (parsed !== undefined) {
      attr.children = leaves(parsed, path, attr.kind, undefined, forces);
      attr.encoded = 'json';
    }
  }
  return finish(attr, b, a);
}

function finish(attr: Attr, b: Value | undefined, a: Value | undefined): Attr {
  if (b !== undefined) attr.before = b;
  if (a !== undefined) attr.after = a;
  return attr;
}

function kindOfChildren(children: Attr[]): AttrKind {
  let add = 0;
  let remove = 0;
  let change = 0;
  for (const c of children) {
    if (c.kind === 'add') add++;
    else if (c.kind === 'remove') remove++;
    else if (c.kind === 'change') change++;
  }
  if (!add && !remove && !change) return 'same';
  return 'change';
}

/** Every value under a one-sided container, as added or removed leaves. */
function leaves(v: Value, path: string, kind: 'add' | 'remove', sens: unknown, forces: Set<string>, unk?: unknown): Attr[] {
  const out: Attr[] = [];
  let entries: [string | number, Value | undefined][];
  if (Array.isArray(v)) {
    const n = Math.max(v.length, Array.isArray(unk) ? unk.length : 0);
    entries = [];
    for (let i = 0; i < n; i++) entries.push([i, v[i]]);
  } else {
    const keys = new Set(Object.keys(v as object));
    if (isObj(unk)) for (const k of Object.keys(unk)) keys.add(k);
    entries = [...keys].sort().map((k) => [k, (v as { [k: string]: Value })[k]]);
  }
  for (const [k, x] of entries) {
    const p = joinPath(path, k);
    const u = at(unk, k);
    const attr: Attr = { key: typeof k === 'number' ? `[${k}]` : k, path: p, kind: x === null && u !== true ? 'same' : kind };
    const s = at(sens, k);
    if (s === true) {
      if (kind === 'add') attr.afterSensitive = true;
      else attr.beforeSensitive = true;
    }
    if (forces.has(p)) attr.forcesReplacement = true;
    if (u === true) {
      attr.afterUnknown = true;
      attr.kind = 'add';
    } else if (x !== null && typeof x === 'object') attr.children = leaves(x, p, kind, s, forces, u);
    else if (x === undefined && (isObj(u) || Array.isArray(u))) attr.children = leaves(Array.isArray(u) ? [] : {}, p, kind, s, forces, u);
    else if (typeof x === 'string' && s !== true) {
      const parsed = parseEncodedJson(x);
      if (parsed !== undefined) {
        attr.children = leaves(parsed, p, kind, undefined, forces);
        attr.encoded = 'json';
      }
    }
    if (x !== undefined) {
      if (kind === 'add') attr.after = x;
      else attr.before = x;
    }
    out.push(attr);
  }
  return out;
}

/** Leaf counts under a tree: how many values are added, changed, removed, unchanged. */
export function countLeaves(attrs: Attr[]): { add: number; change: number; remove: number; same: number } {
  const n = { add: 0, change: 0, remove: 0, same: 0 };
  const walk = (list: Attr[]) => {
    for (const a of list) {
      if (a.children && a.children.length) walk(a.children);
      else if (a.kind === 'add') n.add++;
      else if (a.kind === 'change') n.change++;
      else if (a.kind === 'remove') n.remove++;
      else n.same++;
    }
  };
  walk(attrs);
  return n;
}

/** Dotted paths of every attribute marked as forcing replacement. */
export function forcedPaths(attrs: Attr[]): string[] {
  const out: string[] = [];
  const walk = (list: Attr[]) => {
    for (const a of list) {
      if (a.forcesReplacement) out.push(a.path);
      if (a.children) walk(a.children);
    }
  };
  walk(attrs);
  return out;
}

/**
 * A copy of the tree with sensitive values masked: the values are left out and
 * `maskedBefore` / `maskedAfter` say so. A sensitive container's children are masked too,
 * and a container with a masked value anywhere under it loses its own copy of the value
 * (its children carry the diff), so no secret travels inside a parent.
 */
export function maskAttrs(attrs: Attr[], revealed?: ReadonlySet<string>): Attr[] {
  // Revealing a container reveals what is under it.
  const mask = (a: Attr, parentB: boolean, parentA: boolean, parentShown: boolean): { out: Attr; hidB: boolean; hidA: boolean } => {
    const sb = parentB || !!a.beforeSensitive;
    const sa = parentA || !!a.afterSensitive;
    const show = parentShown || (revealed?.has(a.path) ?? false);
    const out: Attr = { ...a };
    let hidB = false;
    let hidA = false;
    if (sb && !show && out.before !== undefined) {
      delete out.before;
      out.maskedBefore = true;
      hidB = true;
    }
    if (sa && !show && out.after !== undefined) {
      delete out.after;
      out.maskedAfter = true;
      hidA = true;
    }
    if (a.children) {
      out.children = a.children.map((c) => {
        const m = mask(c, sb, sa, show);
        hidB ||= m.hidB;
        hidA ||= m.hidA;
        return m.out;
      });
      if (hidB) delete out.before;
      if (hidA) delete out.after;
    }
    return { out, hidB, hidA };
  };
  return attrs.map((a) => mask(a, false, false, false).out);
}

/** The attribute at a dotted path, or undefined. */
export function attrAt(attrs: Attr[], path: string): Attr | undefined {
  for (const a of attrs) {
    if (a.path === path) return a;
    if (a.children && (path.startsWith(a.path + '.') || path.startsWith(a.path + '['))) {
      const found = attrAt(a.children, path);
      if (found) return found;
    }
  }
  return undefined;
}
