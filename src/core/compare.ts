// Two plans side by side: what changed between two runs (a plan before and after a fix,
// or yesterday's and today's).
import type { Action, Attr, Plan, ResourceChange } from './model';

export type CompareStatus = 'added' | 'removed' | 'action' | 'attrs' | 'same';

export interface CompareRow {
  address: string;
  status: CompareStatus;
  a?: { action: Action; keys: string[] };
  b?: { action: Action; keys: string[] };
  /** Attribute paths whose change differs between the plans. */
  diff?: string[];
}

export interface Comparison {
  rows: CompareRow[];
  counts: Record<CompareStatus, number>;
}

const before = (a: Attr) => (a.beforeSensitive ? '(sensitive)' : a.before === undefined ? '' : JSON.stringify(a.before));
/**
 * Sensitive before unknown: a text plan prints `(sensitive value)` for a value that is both,
 * so a plan's JSON and its own text output agree.
 */
const after = (a: Attr) => (a.afterSensitive ? '(sensitive)' : a.afterUnknown ? '(unknown)' : a.after === undefined ? '' : JSON.stringify(a.after));

/**
 * A signature of each changed leaf, to tell whether the same change is planned. A list of
 * plain values is one entry, its removed and added values: JSON shows `x[0]` changed where
 * the text shows `x[0]` removed and a new `x[0]` added.
 */
function signature(r: ResourceChange): Map<string, string> {
  const m = new Map<string, string>();
  const walk = (list: Attr[]) => {
    for (const a of list) {
      if (a.kind === 'same') continue;
      const whole = a.beforeSensitive || a.afterSensitive || a.afterUnknown;
      const kids = a.children ?? [];
      if (!kids.length || whole) {
        m.set(a.path, `${a.kind}:${before(a)}->${after(a)}`);
        continue;
      }
      const changed = kids.filter((c) => c.kind !== 'same');
      if (kids.every((c) => /^\[\d+\]$/.test(c.key)) && changed.every((c) => !c.children?.length)) {
        const removed = changed.filter((c) => c.kind === 'remove' || c.kind === 'change').map(before).sort();
        const added = changed.filter((c) => c.kind === 'add' || c.kind === 'change').map(after).sort();
        m.set(a.path, `list:${JSON.stringify(removed)}->${JSON.stringify(added)}`);
      } else walk(kids);
    }
  };
  walk(r.attrs);
  return m;
}

export function comparePlans(a: Plan, b: Plan): Comparison {
  const counts: Record<CompareStatus, number> = { added: 0, removed: 0, action: 0, attrs: 0, same: 0 };
  // A deposed object shares its address with the current instance: it is a row of its own.
  const keyOf = (r: ResourceChange) => (r.deposed ? `${r.address} (deposed ${r.deposed})` : r.address);
  const byA = new Map(a.resources.map((r) => [keyOf(r), r]));
  const byB = new Map(b.resources.map((r) => [keyOf(r), r]));
  const rows: CompareRow[] = [];
  const addresses = [...new Set([...byA.keys(), ...byB.keys()])].sort();
  for (const address of addresses) {
    const ra = byA.get(address);
    const rb = byB.get(address);
    const row: CompareRow = { address, status: 'same' };
    if (ra) row.a = { action: ra.action, keys: ra.changedKeys };
    if (rb) row.b = { action: rb.action, keys: rb.changedKeys };
    if (!ra || !rb) {
      // A no-op on the side that has it is no change at all.
      const only = (ra ?? rb)!;
      if (only.action === 'no-op') continue;
      row.status = ra ? 'removed' : 'added';
    } else if (ra.action !== rb.action) row.status = 'action';
    else if (ra.action === 'no-op') continue;
    else {
      const sa = signature(ra);
      const sb = signature(rb);
      const diff = [...new Set([...sa.keys(), ...sb.keys()])].filter((p) => sa.get(p) !== sb.get(p)).sort();
      if (diff.length) {
        row.status = 'attrs';
        row.diff = diff;
      }
    }
    counts[row.status]++;
    rows.push(row);
  }
  const order: Record<CompareStatus, number> = { removed: 0, added: 1, action: 2, attrs: 3, same: 4 };
  rows.sort((x, y) => order[x.status] - order[y.status] || x.address.localeCompare(y.address));
  return { rows, counts };
}
