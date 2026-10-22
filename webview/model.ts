// What the view computes without the DOM: grouping, filtering and value text. Built on its
// own for the tests.
import { ACTION_ORDER, DESTRUCTIVE, REASON_TEXT, type Action, type Attr, type Value } from '../src/core';
import type { Row } from '../src/protocol';

export const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export interface Group {
  /** `module.a[0]`, or '' for the root module. */
  module: string;
  items: number[];
  counts: Record<Action, number>;
}

export interface Filters {
  actions: Record<string, boolean>;
  query: string;
  type: string;
  destructiveOnly: boolean;
  showUnchanged: boolean;
}

export function emptyActionCounts(): Record<Action, number> {
  return { create: 0, update: 0, delete: 0, replace: 0, read: 0, 'no-op': 0, move: 0, import: 0, forget: 0 };
}

const collator = new Intl.Collator(undefined, { numeric: true });

/** Rows grouped by module, the root module first; inside a group the loud actions first. */
export function groupRows(rows: Row[], destructiveFirst: boolean): Group[] {
  const by = new Map<string, Group>();
  for (const r of rows) {
    let g = by.get(r.module);
    if (!g) by.set(r.module, (g = { module: r.module, items: [], counts: emptyActionCounts() }));
    g.items.push(r.i);
    g.counts[r.action]++;
  }
  const groups = [...by.values()].sort((a, b) => (a.module === '' ? -1 : b.module === '' ? 1 : collator.compare(a.module, b.module)));
  const byIndex = new Map(rows.map((r) => [r.i, r]));
  for (const g of groups) {
    g.items.sort((x, y) => {
      const a = byIndex.get(x)!;
      const b = byIndex.get(y)!;
      if (destructiveFirst) {
        const d = ACTION_ORDER[a.action] - ACTION_ORDER[b.action];
        if (d) return d;
      }
      return collator.compare(a.address, b.address);
    });
  }
  return groups;
}

/** Whether a row passes the filters. The query matches the address, type, changed attribute names, reason and the old address. */
export function rowMatches(r: Row, f: Filters): boolean {
  if (r.action === 'no-op' && !f.showUnchanged) return false;
  if (f.actions[r.action] === false) return false;
  if (f.destructiveOnly && !DESTRUCTIVE.has(r.action)) return false;
  if (f.type && r.type !== f.type) return false;
  const q = f.query.trim().toLowerCase();
  if (!q) return true;
  const hay = [r.address, r.type, r.prev ?? '', r.importId ?? '', r.reason ?? '', reasonText(r.reason), ...r.keys, ...r.forces].join('\n').toLowerCase();
  return q.split(/\s+/).every((w) => hay.includes(w));
}

export function reasonText(code: string | undefined): string {
  if (!code) return '';
  return REASON_TEXT[code] ?? code.replace(/_/g, ' ');
}

/** A scalar for one line. Strings keep their quotes, like Terraform's own output. */
export function scalarText(v: Value | undefined, max = 120): string {
  if (v === undefined) return '';
  const s = JSON.stringify(v);
  if (s === undefined) return '';
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

export const isContainer = (v: Value | undefined): boolean => v !== null && typeof v === 'object';

/** How many of an attribute's children change, through nested containers. */
export function changedCount(a: Attr): number {
  if (!a.children) return a.kind === 'same' ? 0 : 1;
  let n = 0;
  for (const c of a.children) n += c.kind === 'same' ? 0 : c.children ? changedCount(c) : 1;
  return n;
}

export function isMultiline(v: Value | undefined): v is string {
  return typeof v === 'string' && v.includes('\n');
}

/** The lines of a before/after text, marked `-`, `+` or ` `. */
export function lineDiff(before: string | undefined, after: string | undefined): { mark: ' ' | '-' | '+'; text: string }[] {
  const b = before === undefined ? [] : before.replace(/\n$/, '').split('\n');
  const a = after === undefined ? [] : after.replace(/\n$/, '').split('\n');
  const out: { mark: ' ' | '-' | '+'; text: string }[] = [];
  // Common prefix and suffix; the middle as removed then added. Enough for config files
  // and user data, without a full LCS on long files.
  let p = 0;
  while (p < b.length && p < a.length && b[p] === a[p]) p++;
  let s = 0;
  while (s < b.length - p && s < a.length - p && b[b.length - 1 - s] === a[a.length - 1 - s]) s++;
  for (let i = 0; i < p; i++) out.push({ mark: ' ', text: b[i] });
  for (let i = p; i < b.length - s; i++) out.push({ mark: '-', text: b[i] });
  for (let i = p; i < a.length - s; i++) out.push({ mark: '+', text: a[i] });
  for (let i = b.length - s; i < b.length; i++) out.push({ mark: ' ', text: b[i] });
  return out;
}

/** The resource types in the rows, most frequent first. */
export function typesOf(rows: Row[]): { type: string; n: number }[] {
  const m = new Map<string, number>();
  for (const r of rows) if (r.action !== 'no-op') m.set(r.type, (m.get(r.type) ?? 0) + 1);
  return [...m.entries()].map(([type, n]) => ({ type, n })).sort((a, b) => b.n - a.n || a.type.localeCompare(b.type));
}
