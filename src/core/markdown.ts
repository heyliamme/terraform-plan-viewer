// Markdown for pull requests: a summary table and each resource's attribute changes in a
// folded <details>. Sensitive values stay masked whatever the view shows.
import { ACTION_LABEL, ACTION_ORDER, actionSymbol, summaryLine, type Attr, type OutputChange, type Plan, type ResourceChange, type Value } from './model';

/** Text in a code span, with a fence longer than any backtick run inside. */
export function codeSpan(s: string): string {
  const runs = s.match(/`+/g) ?? [];
  const n = Math.max(0, ...runs.map((r) => r.length)) + 1;
  const fence = '`'.repeat(n);
  const pad = s.startsWith('`') || s.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${s.replace(/\r?\n/g, ' ')}${pad}${fence}`;
}

/** Plain text that must not start a Markdown construct. */
export const mdText = (s: string) => s.replace(/[\\`*_{}[\]()#+!|<>]/g, '\\$&').replace(/\r?\n/g, ' ');

const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

export function renderValue(v: Value | undefined, max = 80): string {
  if (v === undefined) return '';
  const s = typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v);
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function side(attr: Attr, which: 'before' | 'after'): string {
  if (which === 'after' && attr.afterUnknown) return '(known after apply)';
  if (which === 'before' ? attr.beforeSensitive || attr.maskedBefore : attr.afterSensitive || attr.maskedAfter) return '(sensitive)';
  const v = attr[which];
  if (v === undefined) return '';
  return codeSpan(renderValue(v));
}

/** The leaf attributes that change, flattened with their paths. */
export function changedLeaves(attrs: Attr[]): Attr[] {
  const out: Attr[] = [];
  const walk = (list: Attr[]) => {
    for (const a of list) {
      if (a.kind === 'same') continue;
      const sensitiveWhole = a.beforeSensitive || a.afterSensitive;
      if (a.children && a.children.length && !sensitiveWhole && !a.afterUnknown) walk(a.children);
      else out.push(a);
    }
  };
  walk(attrs);
  return out;
}

function isMultiline(a: Attr): boolean {
  const lines = (v: Value | undefined) => typeof v === 'string' && v.includes('\n');
  return !a.beforeSensitive && !a.afterSensitive && !a.maskedBefore && !a.maskedAfter && (lines(a.before) || lines(a.after));
}

function attrTable(attrs: Attr[]): string[] {
  const leaves = changedLeaves(attrs);
  if (!leaves.length) return ['_No attribute changes shown._'];
  const lines = ['| Attribute | Before | After |', '| --- | --- | --- |'];
  const blocks: string[] = [];
  for (const a of leaves) {
    const mark = a.forcesReplacement ? ' (forces replacement)' : '';
    // A multi-line value becoming unknown: the old value as it is, not every line removed.
    if (isMultiline(a) && a.afterUnknown && typeof a.before === 'string') {
      lines.push(`| ${cell(codeSpan(a.path))}${mark} | _see below_ | (known after apply) |`);
      blocks.push(...currentBlock(a, a.before));
      continue;
    }
    if (isMultiline(a)) {
      lines.push(`| ${cell(codeSpan(a.path))}${mark} | _see below_ | _see below_ |`);
      blocks.push(...multilineBlock(a));
      continue;
    }
    lines.push(`| ${cell(codeSpan(a.path))}${mark} | ${cell(side(a, 'before'))} | ${cell(side(a, 'after'))} |`);
  }
  return [...lines, ...(blocks.length ? ['', ...blocks] : [])];
}

/** A fence longer than any backtick run in the lines, so a ``` line inside can't close it. */
const fenceFor = (lines: string[]) => '`'.repeat(Math.max(3, ...lines.flatMap((l) => l.match(/`+/g) ?? []).map((r) => r.length + 1)));

/** The current value of a multi-line string whose new value is not known yet. */
function currentBlock(a: Attr, before: string): string[] {
  const b = before.replace(/\n$/, '').split('\n');
  const fence = fenceFor(b);
  return [`**${codeSpan(a.path)}** (current value; the new one is known after apply)`, '', fence, ...b, fence, ''];
}

/** A multi-line string as a diff block. */
function multilineBlock(a: Attr): string[] {
  const b = typeof a.before === 'string' ? a.before.replace(/\n$/, '').split('\n') : [];
  const n = typeof a.after === 'string' ? a.after.replace(/\n$/, '').split('\n') : [];
  const fence = fenceFor([...b, ...n]);
  const elided = a.hidden ? ` (${a.hidden} unchanged line${a.hidden === 1 ? '' : 's'} not in the plan output)` : '';
  const out = [`**${codeSpan(a.path)}**${elided}`, '', `${fence}diff`];
  // A simple line diff: common prefix and suffix kept, the middle marked.
  let p = 0;
  while (p < b.length && p < n.length && b[p] === n[p]) p++;
  let s = 0;
  while (s < b.length - p && s < n.length - p && b[b.length - 1 - s] === n[n.length - 1 - s]) s++;
  for (let i = 0; i < p; i++) out.push(` ${b[i]}`);
  for (let i = p; i < b.length - s; i++) out.push(`-${b[i]}`);
  for (let i = p; i < n.length - s; i++) out.push(`+${n[i]}`);
  for (let i = b.length - s; i < b.length; i++) out.push(` ${b[i]}`);
  out.push(fence, '');
  return out;
}

/** Text for HTML: inside `<summary>` Markdown isn't read, so code spans don't protect. */
export const htmlText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/\r?\n/g, ' ');
const htmlCode = (s: string) => `<code>${htmlText(s)}</code>`;

interface Format {
  code: (s: string) => string;
  text: (s: string) => string;
}
const MD: Format = { code: codeSpan, text: mdText };
const HTML: Format = { code: htmlCode, text: htmlText };

function reasonText(rc: ResourceChange, f: Format = MD): string {
  const parts: string[] = [];
  if (rc.replaceOrder === 'create-delete') parts.push('create before destroy');
  if (rc.reason) parts.push(REASON_TEXT[rc.reason] ?? f.text(rc.reason.replace(/_/g, ' ')));
  if (rc.previousAddress) parts.push(`moved from ${f.code(rc.previousAddress)}`);
  if (rc.importId !== undefined) parts.push(rc.importIdUnknown ? 'imported (id known after apply)' : `imported from ${f.code(rc.importId)}`);
  if (rc.deposed) parts.push(`deposed object ${f.text(rc.deposed)}`);
  if (rc.forces.length) parts.push(`forced by ${rc.forces.map(f.code).join(', ')}`);
  return parts.join('; ');
}

export const REASON_TEXT: Record<string, string> = {
  replace_because_tainted: 'tainted',
  replace_because_cannot_update: "the provider can't update it in place",
  replace_by_request: 'replacement requested (-replace)',
  replace_by_triggers: 'replace_triggered_by',
  delete_because_no_resource_config: 'no longer in the configuration',
  delete_because_no_module: 'its module is no longer in the configuration',
  delete_because_wrong_repetition: 'count / for_each changed form',
  delete_because_count_index: 'index out of range for count',
  delete_because_each_key: 'key no longer in for_each',
  delete_because_no_move_target: 'moved block has no target',
  read_because_config_unknown: 'config refers to values not yet known',
  read_because_dependency_pending: 'depends on a resource with changes pending',
  read_because_check_nested: 'read again to verify a check block',
};

export interface MarkdownOptions {
  /** The heading: a file name, "clipboard". */
  title: string;
  /** Resources listed with details; by default every changed one. */
  resources?: ResourceChange[];
  /** Leave out the per-resource details: summary and lists only. */
  summaryOnly?: boolean;
}

/** The plan as Markdown for a pull request comment. */
export function toMarkdown(plan: Plan, opts: MarkdownOptions): string {
  const c = plan.counts;
  const lines: string[] = [`### Terraform plan: ${mdText(opts.title)}`, ''];
  const tool = plan.flavor === 'opentofu' ? 'OpenTofu' : plan.flavor === 'terraform' ? 'Terraform' : '';
  const meta = [tool && plan.terraformVersion ? `${tool} ${plan.terraformVersion}` : tool, plan.timestamp ? `planned ${plan.timestamp}` : ''].filter(Boolean).join(', ');
  const strong = (n: number, s: string) => (n ? `**${s}**` : s);
  const head = [strong(c.create, `${c.create} to add`), `${c.update} to change`, strong(c.delete, `${c.delete} to destroy`)];
  if (c.replace) head.push(`**${c.replace} to replace**`);
  if (c.import) head.push(`${c.import} to import`);
  if (c.move) head.push(`${c.move} moved`);
  if (c.forget) head.push(`${c.forget} to forget`);
  if (c.read) head.push(`${c.read} to read`);
  lines.push(head.join(', ') + (meta ? ` · ${meta}` : ''), '');
  if (plan.errored) lines.push('> **The plan failed part way through.** What follows is what had been planned before the error.', '');
  for (const d of plan.diagnostics.filter((x) => x.severity === 'error' || x.severity === 'warning')) lines.push(`> **${d.severity === 'error' ? 'Error' : 'Warning'}:** ${mdText(d.summary)}`, '');

  const changed = (opts.resources ?? plan.resources).filter((r) => r.action !== 'no-op');
  const byAction = new Map<string, ResourceChange[]>();
  for (const r of changed) byAction.set(r.action, [...(byAction.get(r.action) ?? []), r]);
  if (changed.length) {
    lines.push('| Action | Count | Resource types |', '| --- | ---: | --- |');
    for (const action of [...byAction.keys()].sort((a, b) => ACTION_ORDER[a as keyof typeof ACTION_ORDER] - ACTION_ORDER[b as keyof typeof ACTION_ORDER])) {
      const rs = byAction.get(action)!;
      const types = [...new Set(rs.map((r) => r.type))].sort();
      const shown = types.slice(0, 6).map(codeSpan).join(', ') + (types.length > 6 ? ` and ${types.length - 6} more` : '');
      lines.push(`| ${actionSymbol(action as ResourceChange['action'])} ${ACTION_LABEL[action as ResourceChange['action']]} | ${rs.length} | ${shown} |`);
    }
    lines.push('');
  } else lines.push(plan.drift.length || c.outputs ? 'No resource changes.' : 'No changes.', '');

  if (plan.drift.length) {
    lines.push(`#### Changed outside of ${tool || 'Terraform'} (${plan.drift.length})`, '');
    for (const r of plan.drift) lines.push(`- ${codeSpan(r.address)}: ${r.action === 'delete' ? 'deleted' : 'changed'}${r.changedKeys.length && r.action !== 'delete' ? ` (${r.changedKeys.map(codeSpan).join(', ')})` : ''}`);
    lines.push('');
  }

  if (!opts.summaryOnly) {
    const sorted = [...changed].sort((a, b) => ACTION_ORDER[a.action] - ACTION_ORDER[b.action] || a.address.localeCompare(b.address));
    for (const r of sorted) {
      // A raw HTML block: everything in it is escaped as HTML (an address can hold `<!--`).
      const label = `${htmlText(actionSymbol(r.action, r.replaceOrder))} ${htmlCode(r.address)}`;
      const why = reasonText(r, HTML);
      lines.push('<details>', `<summary>${label} — ${ACTION_LABEL[r.action]}${why ? ` (${why})` : ''}</summary>`, '');
      if (r.action === 'move' || (r.action === 'no-op' && r.previousAddress)) lines.push(`Moved from ${codeSpan(r.previousAddress!)}; no other change.`);
      else if (r.action === 'forget') lines.push('Removed from the state; the real object is kept.');
      else if (r.action === 'import' && !r.changedKeys.length) lines.push(`Imported from ${r.importId !== undefined ? codeSpan(r.importId) : 'an id known after apply'}; the configuration matches.`);
      else lines.push(...attrTable(r.attrs));
      if (r.unparsed?.length) lines.push('', `_${r.unparsed.length} line${r.unparsed.length === 1 ? '' : 's'} of this resource could not be read._`);
      lines.push('', '</details>', '');
    }
  } else if (changed.length) {
    for (const action of [...byAction.keys()].sort((a, b) => ACTION_ORDER[a as keyof typeof ACTION_ORDER] - ACTION_ORDER[b as keyof typeof ACTION_ORDER])) {
      lines.push(`#### ${cap(ACTION_LABEL[action as ResourceChange['action']])} (${byAction.get(action)!.length})`, '');
      for (const r of byAction.get(action)!) {
        const why = reasonText(r);
        lines.push(`- ${codeSpan(r.address)}${why ? ` — ${why}` : ''}`);
      }
      lines.push('');
    }
  }

  const outs = plan.outputs.filter((o) => o.action !== 'no-op');
  if (outs.length) {
    lines.push(`#### Outputs (${outs.length})`, '', '| Output | Action | Before | After |', '| --- | --- | --- | --- |');
    for (const o of outs) lines.push(`| ${codeSpan(o.name)} | ${o.action === 'delete' ? 'destroy' : o.action} | ${cell(outputSide(o, 'before'))} | ${cell(outputSide(o, 'after'))} |`);
    lines.push('');
  }
  const failing = plan.checks.filter((k) => k.status !== 'pass');
  if (failing.length) {
    lines.push(`#### Checks not passing (${failing.length})`, '');
    for (const k of failing) {
      const problems = k.instances.flatMap((x) => x.problems);
      lines.push(`- ${codeSpan(k.address)}: ${k.status}${problems.length ? ` — ${mdText(problems.join('; '))}` : ''}`);
    }
    lines.push('');
  }
  if (plan.source === 'text' && plan.unparsed.length) lines.push(`_${plan.unparsed.length} line${plan.unparsed.length === 1 ? '' : 's'} of the plan text could not be read._`, '');
  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}

function outputSide(o: OutputChange, which: 'before' | 'after'): string {
  if (which === 'after' && o.afterUnknown) return '(known after apply)';
  if (which === 'before' ? o.beforeSensitive || o.maskedBefore : o.afterSensitive || o.maskedAfter) return '(sensitive)';
  const v = o[which];
  if (v === undefined) return '';
  return codeSpan(renderValue(v)) + (which === 'after' && o.afterPartlyUnknown ? ' (parts known after apply)' : '');
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** One line plus the addresses by action: for a chat message or a commit. */
export function toSummary(plan: Plan, title: string): string {
  const lines = [`${title}: ${summaryLine(plan.counts)}${plan.drift.length ? `, ${plan.drift.length} changed outside` : ''}${plan.errored ? ' (plan errored)' : ''}`];
  const changed = plan.resources.filter((r) => r.action !== 'no-op').sort((a, b) => ACTION_ORDER[a.action] - ACTION_ORDER[b.action] || a.address.localeCompare(b.address));
  let last = '';
  for (const r of changed) {
    if (r.action !== last) {
      lines.push('', `${ACTION_LABEL[r.action]}:`);
      last = r.action;
    }
    const why = r.forces.length ? ` (forced by ${r.forces.join(', ')})` : r.previousAddress ? ` (from ${r.previousAddress})` : '';
    lines.push(`  ${actionSymbol(r.action, r.replaceOrder)} ${r.address}${why}`);
  }
  const outs = plan.outputs.filter((o) => o.action !== 'no-op');
  if (outs.length) {
    lines.push('', 'outputs:');
    for (const o of outs) lines.push(`  ${o.action === 'create' ? '+' : o.action === 'delete' ? '-' : '~'} ${o.name}`);
  }
  return lines.join('\n') + '\n';
}
