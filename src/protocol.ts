// Messages between the extension and the view. The view gets rows, and asks for a
// resource's attributes when it is opened; sensitive values stay with the host until
// revealed one by one.
import type { Action, Attr, CompareRow, CompareStatus, Counts, Diagnostic, ReplaceOrder, Unparsed, Value } from './core';

export interface Row {
  i: number;
  address: string;
  module: string;
  mode: 'managed' | 'data';
  type: string;
  name: string;
  action: Action;
  order?: ReplaceOrder;
  reason?: string;
  prev?: string;
  importId?: string;
  importIdUnknown?: boolean;
  deposed?: string;
  forces: string[];
  /** Top-level attributes that change. */
  keys: string[];
  n: { add: number; change: number; remove: number; same: number };
  /** Text plans: lines in this resource that couldn't be read. */
  unparsed?: number;
}

export interface OutputRow {
  name: string;
  action: 'create' | 'update' | 'delete' | 'no-op';
  before?: Value;
  after?: Value;
  afterUnknown?: boolean;
  /** Parts of `after` read `(known after apply)`. */
  afterPartlyUnknown?: boolean;
  maskedBefore?: boolean;
  maskedAfter?: boolean;
  sensitive?: boolean;
}

export interface CheckRow {
  address: string;
  kind: string;
  status: 'pass' | 'fail' | 'error' | 'unknown';
  instances: { address: string; status: string; problems: string[] }[];
}

export type SourceKind = 'file' | 'binary' | 'clipboard' | 'run' | 'editor';

export interface PlanInfo {
  label: string;
  detail?: string;
  source: SourceKind;
  kind: 'json' | 'text';
  flavor: 'terraform' | 'opentofu' | 'unknown';
  version?: string;
  formatVersion?: string;
  timestamp?: string;
  errored?: boolean;
  planLine?: string;
  counts: Counts;
  summary: string;
  rows: Row[];
  drift: Row[];
  outputs: OutputRow[];
  checks: CheckRow[];
  diagnostics: Diagnostic[];
  notes: string[];
  unparsed: Unparsed[];
  /** Whether jumping to the HCL block can work (a workspace with .tf files is open). */
  canJump: boolean;
  canOpenSource: boolean;
  /** There is a file or editor to compare with another plan. */
  canCompare: boolean;
  /** Sensitive values are masked until revealed. */
  masked: boolean;
  destructiveFirst: boolean;
  showUnchanged: boolean;
  ms: number;
}

export interface CompareInfo {
  a: string;
  b: string;
  counts: Record<CompareStatus, number>;
  rows: CompareRow[];
}

export interface ErrorInfo {
  message: string;
  detail?: string;
  /** Buttons: what the host can do about it. */
  actions?: { id: string; label: string }[];
}

export type ToWebview =
  | { type: 'loading'; label?: string }
  | { type: 'plan'; plan: PlanInfo }
  | { type: 'compare'; compare: CompareInfo }
  | { type: 'error'; error: ErrorInfo }
  | { type: 'detail'; i: number; drift: boolean; attrs: Attr[] }
  | { type: 'outputs'; outputs: OutputRow[] }
  /** What the serializer needs to reopen the view; the view stores it with its own state. */
  | { type: 'persist'; state: unknown }
  | { type: 'view'; view: ViewState };

export type FromWebview =
  | { type: 'ready' }
  | { type: 'detail'; i: number; drift: boolean }
  | { type: 'reveal'; i: number; drift: boolean; path: string; on: boolean }
  | { type: 'revealOutput'; name: string; on: boolean }
  | { type: 'copyMarkdown' }
  | { type: 'copySummary' }
  | { type: 'jump'; address: string }
  | { type: 'openSource' }
  | { type: 'reload' }
  | { type: 'compare' }
  | { type: 'action'; id: string };

/** What the view remembers across reloads. */
export interface ViewState {
  actions?: Record<string, boolean>;
  query?: string;
  typeFilter?: string;
  destructiveOnly?: boolean;
  expanded?: string[];
  collapsed?: string[];
}

/** Checks a message from the view: anything else is dropped. */
export function isFromWebview(m: unknown): m is FromWebview {
  if (!m || typeof m !== 'object') return false;
  const o = m as Record<string, unknown>;
  const int = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < 10_000_000;
  const str = (v: unknown, max = 4096) => typeof v === 'string' && v.length <= max;
  const bool = (v: unknown) => typeof v === 'boolean';
  switch (o.type) {
    case 'ready':
    case 'copyMarkdown':
    case 'copySummary':
    case 'openSource':
    case 'reload':
    case 'compare':
      return true;
    case 'detail':
      return int(o.i) && bool(o.drift);
    case 'reveal':
      return int(o.i) && bool(o.drift) && str(o.path) && bool(o.on);
    case 'revealOutput':
      return str(o.name, 512) && bool(o.on);
    case 'jump':
      return str(o.address, 2048);
    case 'action':
      return str(o.id, 64) && /^[a-zA-Z]+$/.test(o.id as string);
    default:
      return false;
  }
}
