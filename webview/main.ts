import { ACTION_LABEL, actionSymbol, type Action, type Attr, type Value } from '../src/core';
import type { CompareInfo, ErrorInfo, FromWebview, OutputRow, PlanInfo, Row, ToWebview, ViewState } from '../src/protocol';
import { changedCount, esc, groupRows, isMultiline, lineDiff, reasonText, rowMatches, scalarText, typesOf, type Filters, type Group } from './model';

declare function acquireVsCodeApi(): { postMessage(m: FromWebview): void; setState(s: unknown): void; getState(): unknown };
const vscode = acquireVsCodeApi();
const post = (m: FromWebview) => vscode.postMessage(m);

const ACTIONS: Action[] = ['delete', 'replace', 'create', 'update', 'import', 'move', 'forget', 'read', 'no-op'];
const ACTION_ICON: Record<Action, string> = { create: 'add', update: 'edit', delete: 'trash', replace: 'sync', read: 'eye', 'no-op': 'circle-outline', move: 'arrow-right', import: 'cloud-download', forget: 'debug-disconnect' };
/** Rows a group shows at once; the rest come in as you scroll. */
const CHUNK = 200;
/** Strings longer than this fold until asked for. */
const LONG = 160;

const saved = (vscode.getState() ?? {}) as { persist?: unknown; view?: ViewState };
let persist = saved.persist;
const view = {
  actions: { ...(saved.view?.actions ?? {}) } as Record<string, boolean>,
  query: saved.view?.query ?? '',
  type: saved.view?.typeFilter ?? '',
  destructiveOnly: saved.view?.destructiveOnly ?? false,
  expanded: new Set<string>(saved.view?.expanded ?? []),
  collapsed: new Set<string>(saved.view?.collapsed ?? []),
};
let plan: PlanInfo | undefined;
let compare: CompareInfo | undefined;
let rowsByKey = new Map<string, Row>();
const details = new Map<string, Attr[]>();
/** Rows whose attributes were asked for since the last plan arrived. */
const requested = new Set<string>();
/** Containers whose unchanged children are shown, and values shown in full: `${key}|${path}`. */
const openSame = new Set<string>();
const fullValues = new Set<string>();
let showAllOutputs = false;
/** The showUnchanged setting as the last plan message had it. */
let lastSetting: boolean | undefined;

const icon = (name: string, cls = '') => `<span class="codicon codicon-${name}${cls ? ' ' + cls : ''}" aria-hidden="true"></span>`;

const app = document.getElementById('app')!;
app.innerHTML = `
<div class="progress" id="progress" role="progressbar" aria-label="Loading" hidden><div></div></div>
<header class="bar">
  <div class="title">
    <span class="tool" id="tool"></span>
    <span class="label" id="label"></span>
    <span class="detail" id="detail"></span>
  </div>
  <div class="actions">
    <button id="copy" title="Copy the plan as Markdown for a pull request: summary table and each resource's changes, sensitive values masked" disabled>${icon('copy')} Copy as Markdown</button>
    <button id="copySummary" title="Copy a short summary: the counts and the addresses by action" disabled>${icon('list-flat')} Copy summary</button>
    <button id="openSource" class="icon" title="Open the file this plan was read from" aria-label="Open the source file" hidden>${icon('go-to-file')}</button>
    <button id="reload" class="icon" title="Read the plan again" aria-label="Reload">${icon('refresh')}</button>
  </div>
</header>
<div class="headline" id="headline"></div>
<div class="summary" id="summary" role="toolbar" aria-label="Show changes by action"></div>
<div id="cards"></div>
<div class="filter" id="filter" hidden>
  <span class="search">${icon('search')}<input id="search" type="search" placeholder="Filter by address, type or attribute" aria-label="Filter resources" spellcheck="false"></span>
  <select id="typeFilter" aria-label="Resource type"></select>
  <button id="destructive" class="tog" aria-pressed="false" title="Only resources that are destroyed or replaced">${icon('flame')} Destructive only</button>
  <button id="expand" class="link" title="Open or fold every resource shown">Expand all</button>
</div>
<div id="status" class="sr-only" role="status"></div>
<main id="main"></main>
`;
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const search = $<HTMLInputElement>('search');
search.value = view.query;

/**
 * What the view remembers across a window reload. The open resources, the search text and the
 * folded modules name things in the plan, so they are kept only for a plan read from a file,
 * which is on disk anyway: a plan from the clipboard, a run or an unsaved editor leaves none
 * of its addresses behind.
 */
function saveState() {
  const fromFile = !plan || plan.source === 'file' || plan.source === 'binary';
  vscode.setState({ persist, view: { actions: view.actions, query: fromFile ? view.query : '', typeFilter: fromFile ? view.type : '', destructiveOnly: view.destructiveOnly, expanded: fromFile ? [...view.expanded].slice(0, 500) : [], collapsed: fromFile ? [...view.collapsed] : [] } satisfies ViewState });
}

/**
 * Whether unchanged resources show: the chip once the person has used it, else the
 * showUnchanged setting (an unset chip follows the setting as it changes).
 */
const showNoop = () => view.actions['no-op'] ?? plan?.showUnchanged ?? false;

function filters(): Filters {
  return { actions: view.actions, query: view.query, type: view.type, destructiveOnly: view.destructiveOnly, showUnchanged: showNoop() };
}

/** Whether the person narrowed the list (the default hiding of unchanged resources aside). */
function userFiltered(): boolean {
  return !!view.query.trim() || !!view.type || view.destructiveOnly || ACTIONS.some((a) => a !== 'no-op' && view.actions[a] === false);
}

/**
 * A row's key, for what stays open across reloads: by address, so a rewritten plan whose
 * order shifted opens the same resources again.
 */
const keyOf = (r: Row, drift: boolean) => `${drift ? 'd' : 'r'}:${r.address}${r.deposed ? ` (deposed ${r.deposed})` : ''}`;

// --- header -------------------------------------------------------------------------

function toolName(p: PlanInfo): string {
  return p.flavor === 'opentofu' ? 'OpenTofu' : p.flavor === 'terraform' ? 'Terraform' : 'Terraform';
}

function renderHeader(p: PlanInfo) {
  const tool = `${toolName(p)}${p.version ? ' ' + esc(p.version) : ''}`;
  const from = p.source === 'binary' ? 'binary plan' : p.source === 'clipboard' ? 'from the clipboard' : p.source === 'run' ? 'plan run' : p.kind === 'text' ? 'text output' : 'plan JSON';
  $('tool').innerHTML = `<span class="pill" title="Which tool wrote the plan, from its providers">${tool}</span><span class="pill muted" title="Where this plan came from">${from}</span>`;
  $('label').textContent = p.label;
  $('label').title = p.detail ?? p.label;
  $('detail').textContent = p.detail && p.detail !== p.label ? p.detail : '';
  $<HTMLButtonElement>('copy').disabled = false;
  $<HTMLButtonElement>('copySummary').disabled = false;
  $('copy').hidden = false;
  $('copySummary').hidden = false;
  $('openSource').hidden = !p.canOpenSource;
  const c = p.counts;
  const strong = (n: number, s: string, cls: string) => (n ? `<b class="${cls}">${s}</b>` : `<span class="muted">${s}</span>`);
  const parts = [strong(c.create, `${c.create} to add`, 'c-create'), strong(c.update, `${c.update} to change`, 'c-update'), strong(c.delete, `${c.delete} to destroy`, 'c-delete')];
  if (c.replace) parts.push(`<b class="c-replace">${c.replace} to replace</b>`);
  if (c.import) parts.push(`<b class="c-import">${c.import} to import</b>`);
  if (c.move) parts.push(`<b class="c-move">${c.move} moved</b>`);
  if (c.forget) parts.push(`<b class="c-forget">${c.forget} to forget</b>`);
  if (c.read) parts.push(`<span class="muted">${c.read} to read</span>`);
  let line = parts.join('<span class="sep">, </span>');
  const nothing = !c.create && !c.update && !c.delete && !c.replace && !c.import && !c.move && !c.forget && !c.outputs && !p.drift.length;
  if (nothing) line = `<span class="ok">${icon('pass')} No changes.</span> <span class="muted">Your infrastructure matches the configuration.</span>`;
  const extra: string[] = [];
  if (p.drift.length) extra.push(`<a href="#drift" class="link" id="goDrift">${p.drift.length} changed outside of ${toolName(p)}</a>`);
  if (c.outputs) extra.push(`<a href="#outputs" class="link" id="goOutputs">${c.outputs} output${c.outputs === 1 ? '' : 's'}</a>`);
  const failing = p.checks.filter((k) => k.status !== 'pass').length;
  if (failing) extra.push(`<a href="#checks" class="link warn" id="goChecks">${icon('warning')} ${failing} check${failing === 1 ? '' : 's'} not passing</a>`);
  $('headline').innerHTML = `<div class="line">${line}</div>${extra.length ? `<div class="extra">${extra.join('<span class="sep"> · </span>')}</div>` : ''}<span class="time" title="Time to read the plan">${p.ms} ms</span>`;
  // Chips: a filter per action present.
  const chips: string[] = [];
  const counts: Record<string, number> = {};
  for (const r of p.rows) counts[r.action] = (counts[r.action] ?? 0) + 1;
  for (const a of ACTIONS) {
    const n = counts[a] ?? 0;
    if (!n) continue;
    const on = a === 'no-op' ? showNoop() : view.actions[a] !== false;
    chips.push(`<button class="chip a-${a}" data-action="${a}" aria-pressed="${on}" title="${on ? 'Hide' : 'Show'} ${ACTION_LABEL[a]}">${icon(ACTION_ICON[a])}<b>${n}</b><span class="name"> ${a === 'no-op' ? 'unchanged' : ACTION_LABEL[a]}</span></button>`);
  }
  $('summary').innerHTML = chips.join('');
  $('filter').hidden = !p.rows.length && !p.drift.length;
  const sel = $<HTMLSelectElement>('typeFilter');
  const types = typesOf(p.rows);
  sel.innerHTML = `<option value="">All types${types.length ? ` (${types.length})` : ''}</option>` + types.map((t) => `<option value="${esc(t.type)}"${t.type === view.type ? ' selected' : ''}>${esc(t.type)} (${t.n})</option>`).join('');
  if (view.type && !types.some((t) => t.type === view.type)) {
    view.type = '';
    sel.value = '';
  }
  $('destructive').setAttribute('aria-pressed', String(view.destructiveOnly));
}

function renderCards(p: PlanInfo) {
  const cards: string[] = [];
  if (p.errored) cards.push(`<div class="card error">${icon('error')}<div><b>The plan failed part way through.</b> What is shown is what ${toolName(p)} had planned before the error; the real plan may differ.</div></div>`);
  for (const d of p.diagnostics) {
    if (p.errored && d.severity === 'error' && /failed part way/.test(d.summary)) continue;
    const cls = d.severity === 'error' ? 'error' : d.severity === 'warning' ? 'warn' : 'info';
    const ico = d.severity === 'error' ? 'error' : d.severity === 'warning' ? 'warning' : 'info';
    cards.push(d.detail ? `<details class="card ${cls}"><summary>${icon(ico)} <b>${esc(cap(d.severity))}:</b> ${esc(d.summary)}</summary><pre>${esc(d.detail)}</pre></details>` : `<div class="card ${cls}">${icon(ico)}<div><b>${esc(cap(d.severity))}:</b> ${esc(d.summary)}</div></div>`);
  }
  if (p.notes.length) cards.push(`<div class="card info">${icon('info')}<div>${p.notes.map((n) => esc(n)).join('<br>')}</div></div>`);
  if (p.unparsed.length) {
    cards.push(`<details class="card warn" id="unparsed"><summary>${icon('warning')} <b>Could not read ${p.unparsed.length} line${p.unparsed.length === 1 ? '' : 's'}</b> of the plan text; they are left out of what is shown</summary><pre>${p.unparsed.map((u) => `${String(u.line).padStart(6)}  ${esc(u.text)}`).join('\n')}</pre></details>`);
  }
  $('cards').innerHTML = cards.join('');
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// --- the tree -----------------------------------------------------------------------

function render() {
  const p = plan;
  if (!p) return;
  const active = document.activeElement;
  const refocus = active && active !== document.body ? focusSelector(active) : undefined;
  renderHeader(p);
  renderCards(p);
  const main = $('main');
  const f = filters();
  const driftRows = p.drift.filter((r) => rowMatches(r, { ...f, actions: {}, showUnchanged: true }));
  const rows = p.rows.filter((r) => rowMatches(r, f));
  const html: string[] = [];
  let shown = 0;
  // Rows past the first chunk of each group, for its sentinel: from this render's filter.
  pending.clear();
  groupSeq = 0;
  if (p.rows.length || p.drift.length) {
    const tree: string[] = [];
    // Drift first, in the same tree. The sections are layout only (role none): a group's
    // header is the treeitem, and owns its rows.
    if (p.drift.length) {
      tree.push(`<section class="group drift" id="drift" data-module="drift" role="none">${groupHead('drift', `Changed outside of ${toolName(p)}`, driftRows.length, p.drift.length, countActions(driftRows))}${rowsHtml(driftRows, true, 'drift')}</section>`);
      shown += driftRows.length;
    }
    const groups = groupRows(rows, p.destructiveFirst);
    for (const g of groups) {
      const key = g.module || 'root';
      const items = g.items.map((i) => p.rows[i]);
      tree.push(`<section class="group" data-module="${esc(key)}" role="none">${groupHead(key, g.module || 'Root module', items.length, items.length, g.counts)}${rowsHtml(items, false, key)}</section>`);
      shown += items.length;
    }
    html.push(`<div id="tree" role="tree" aria-label="Planned changes">${tree.join('')}</div>`);
    if (!groups.length && !driftRows.length) {
      const unchanged = p.rows.filter((r) => r.action === 'no-op').length;
      // Nothing to show because nothing changes: say so, rather than blame a filter.
      // Outputs can still change when every resource stays as it is.
      const outputsChange = p.outputs.some((o) => o.action !== 'no-op');
      if (!userFiltered() && unchanged === p.rows.length && !p.drift.length && outputsChange) html.push(`<div class="empty">${icon('pass', 'ok')}<p><b>No resource changes.</b></p><p class="muted">${unchanged} resource${unchanged === 1 ? '' : 's'}, all unchanged; only outputs change.</p><button class="link" id="showUnchanged">Show ${unchanged} unchanged</button></div>`);
      else if (!userFiltered() && unchanged === p.rows.length && !p.drift.length) html.push(`<div class="empty">${icon('pass', 'ok')}<p><b>No changes.</b></p><p class="muted">${unchanged} resource${unchanged === 1 ? '' : 's'}, all unchanged.</p><button class="link" id="showUnchanged">Show ${unchanged} unchanged</button></div>`);
      else html.push(`<div class="empty">${icon('filter')}<p>No resources match the filter.</p>${userFiltered() ? '<button class="link" id="clearFilter">Clear the filter</button>' : ''}</div>`);
    }
  } else if (!p.outputs.length && !p.checks.length) {
    html.push(`<div class="empty">${icon('pass', 'ok')}<p><b>No changes.</b></p><p class="muted">The plan lists no resource changes${p.kind === 'text' ? ' that could be read' : ''}.</p></div>`);
  }
  html.push(outputsHtml(p.outputs), checksHtml(p));
  main.innerHTML = html.join('');
  // Groups the view decided to fold come back folded; the rest open.
  for (const key of view.collapsed) main.querySelector(`.group[data-module="${CSS.escape(key)}"]`)?.classList.add('collapsed');
  for (const el of main.querySelectorAll<HTMLElement>('.sentinel')) observer.observe(el);
  // Open details that were open.
  for (const li of main.querySelectorAll<HTMLElement>('.res[data-key]')) if (view.expanded.has(li.dataset.key!)) openDetail(li, false);
  $('status').textContent = `${shown} of ${p.rows.length + p.drift.length} resources shown`;
  fixTabStop();
  if (refocus && (!document.activeElement || document.activeElement === document.body)) (document.querySelector(refocus) as HTMLElement | null)?.focus();
  updateExpandButton();
}

function countActions(rows: Row[]): Record<Action, number> {
  const c = { create: 0, update: 0, delete: 0, replace: 0, read: 0, 'no-op': 0, move: 0, import: 0, forget: 0 } as Record<Action, number>;
  for (const r of rows) c[r.action]++;
  return c;
}

function groupHead(key: string, name: string, shown: number, total: number, counts: Record<Action, number>): string {
  const collapsed = view.collapsed.has(key);
  const cs = ACTIONS.filter((a) => counts[a] && a !== 'no-op')
    .map((a) => `<span class="count a-${a}" title="${counts[a]} ${ACTION_LABEL[a]}">${icon(ACTION_ICON[a])}${counts[a]}<span class="sr-only"> ${ACTION_LABEL[a]},</span></span>`)
    .join('');
  const hidden = total > shown ? `<span class="muted"> · ${total - shown} hidden by the filter</span>` : '';
  return `<div class="ghead" role="treeitem" aria-level="1" aria-expanded="${!collapsed}" aria-owns="rows-${groupSeq}" tabindex="-1">${icon(collapsed ? 'chevron-right' : 'chevron-down', 'chev')}<span class="gname">${esc(name)}</span><span class="gmeta">${shown} resource${shown === 1 ? '' : 's'}${hidden}</span><span class="counts">${cs}</span></div>`;
}

/** Numbers the groups of one render: a header owns its rows by id. */
let groupSeq = 0;

function rowsHtml(rows: Row[], drift: boolean, group: string): string {
  const first = rows.slice(0, CHUNK);
  let rest = '';
  if (rows.length > CHUNK) {
    pending.set(`${drift}:${group}`, rows);
    rest = `<li class="sentinel" role="none" data-group="${esc(group)}" data-drift="${drift}" data-from="${CHUNK}">Loading ${rows.length - CHUNK} more…</li>`;
  }
  return `<ul class="rows" role="group" id="rows-${groupSeq++}">${first.map((r) => rowHtml(r, drift)).join('')}${rest}</ul>`;
}

/** Rows past the first chunk, kept here for the sentinel; rebuilt by every render. */
const pending = new Map<string, Row[]>();

const observer = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const el = e.target as HTMLElement;
      const key = `${el.dataset.drift}:${el.dataset.group}`;
      const rows = pending.get(key);
      const from = Number(el.dataset.from);
      if (!rows) {
        el.remove();
        continue;
      }
      const next = rows.slice(from, from + CHUNK);
      el.insertAdjacentHTML('beforebegin', next.map((r) => rowHtml(r, el.dataset.drift === 'true')).join(''));
      for (const li of [...el.parentElement!.querySelectorAll<HTMLElement>('.res[data-key]')].slice(-next.length)) if (view.expanded.has(li.dataset.key!)) openDetail(li, false);
      if (from + CHUNK >= rows.length) {
        observer.unobserve(el);
        el.remove();
      } else {
        el.dataset.from = String(from + CHUNK);
        el.textContent = `Loading ${rows.length - from - CHUNK} more…`;
      }
      fixTabStop();
    }
  },
  { rootMargin: '1200px 0px' },
);

let rowSeq = 0;

function rowHtml(r: Row, drift: boolean): string {
  const key = keyOf(r, drift);
  const tags: string[] = [];
  if (r.order === 'create-delete') tags.push(`<span class="tag" title="The replacement is created before the old object is destroyed">create before destroy</span>`);
  if (r.deposed) tags.push(`<span class="tag" title="An old object left over from an earlier create-before-destroy">deposed ${esc(r.deposed)}</span>`);
  if (r.prev) tags.push(`<span class="tag mv" title="Moved from ${esc(r.prev)}">${icon('arrow-right')} from <code>${esc(r.prev)}</code></span>`);
  if (r.importId !== undefined) tags.push(`<span class="tag" title="Imported into the state">${icon('cloud-download')} ${r.importIdUnknown ? 'id known after apply' : `id <code>${esc(r.importId)}</code>`}</span>`);
  if (r.reason && r.reason !== 'replace_because_cannot_update') tags.push(`<span class="tag why">${esc(reasonText(r.reason))}</span>`);
  if (r.forces.length) tags.push(`<span class="tag force" title="Changing ${esc(r.forces.join(', '))} needs a new object">${icon('flame')} forces replacement: ${esc(r.forces.slice(0, 3).join(', '))}${r.forces.length > 3 ? ` +${r.forces.length - 3}` : ''}</span>`);
  if (r.unparsed) tags.push(`<span class="tag warn" title="Lines of this resource the text reader skipped">${icon('warning')} ${r.unparsed} unread line${r.unparsed === 1 ? '' : 's'}</span>`);
  const keys = r.action === 'update' || r.action === 'replace' || (drift && r.action !== 'delete') ? r.keys.filter((k) => !r.forces.includes(k)) : [];
  const keysHtml = keys.length ? `<span class="keys" title="Attributes that change">${keys.slice(0, 6).map(esc).join(', ')}${keys.length > 6 ? ` +${keys.length - 6}` : ''}</span>` : '';
  const n = r.n;
  const total = n.add + n.change + n.remove;
  const plural = (k: number, w: string) => `${k} ${w}${k === 1 ? '' : 's'}`;
  const counts = r.action === 'create' || r.action === 'read' ? plural(n.add, 'attribute') : r.action === 'delete' ? plural(n.remove, 'attribute') : r.action === 'no-op' || r.action === 'move' || r.action === 'forget' || (r.action === 'import' && !total) ? plural(n.same, 'attribute') : plural(total, 'change');
  const sym = actionSymbol(r.action, r.order);
  const label = `${ACTION_LABEL[r.action]}${r.order === 'create-delete' ? ' (create before destroy)' : ''}: ${r.address}`;
  const jump = plan?.canJump && !drift ? `<button class="icon jump" tabindex="-1" title="Go to the ${r.mode === 'data' ? 'data' : 'resource'} block in the .tf files" aria-label="Go to the block of ${esc(r.address)}">${icon('code')}</button>` : '';
  // The label names the row; the tags (what forces the replacement, moves, imports) and the
  // counts are its description, so a screen reader hears them too.
  const id = `row-${++rowSeq}`;
  return `<li class="res a-${r.action}" role="treeitem" aria-level="2" aria-expanded="false" data-key="${esc(key)}" data-i="${r.i}" data-drift="${drift}" tabindex="-1" aria-label="${esc(label)}" aria-describedby="${id}-t ${id}-m">
    <div class="line">${icon('chevron-right', 'chev')}<span class="sym s-${r.action}" title="${ACTION_LABEL[r.action]}">${esc(sym)}</span><span class="addr"><span class="mod">${esc(r.module ? r.module + '.' : '')}</span>${esc(r.address.slice(r.module ? r.module.length + 1 : 0))}</span><span class="tags" id="${id}-t">${tags.join('')}</span>${keysHtml}<span class="rmeta" id="${id}-m">${counts}</span><span class="rowacts">${jump}</span></div>
    <div class="detail" hidden></div>
  </li>`;
}

// --- details ----------------------------------------------------------------------

function openDetail(li: HTMLElement, request = true) {
  const key = li.dataset.key!;
  li.setAttribute('aria-expanded', 'true');
  li.classList.add('open');
  const box = li.querySelector<HTMLElement>('.detail')!;
  box.hidden = false;
  const attrs = details.get(key);
  if (attrs) box.innerHTML = detailHtml(key, attrs, li);
  else {
    box.innerHTML = `<p class="loading">Loading…</p>`;
    // Rows reopened after a new plan arrived have nothing cached yet: ask once for them too.
    if (request || !requested.has(key)) {
      requested.add(key);
      post({ type: 'detail', i: Number(li.dataset.i), drift: li.dataset.drift === 'true' });
    }
  }
}

function closeDetail(li: HTMLElement) {
  li.setAttribute('aria-expanded', 'false');
  li.classList.remove('open');
  const box = li.querySelector<HTMLElement>('.detail')!;
  box.hidden = true;
  box.innerHTML = '';
}

function detailHtml(key: string, attrs: Attr[], li: HTMLElement): string {
  const r = rowsByKey.get(key);
  const notes: string[] = [];
  if (r?.action === 'move') notes.push(`Moved from <code>${esc(r.prev ?? '')}</code>; no other change.`);
  if (r?.action === 'forget') notes.push('Removed from the state; the real object is kept as it is.');
  if (r?.action === 'import' && !r.keys.length) notes.push(`Imported${r.importId !== undefined ? ` from <code>${esc(r.importId)}</code>` : ''}; the configuration matches the object.`);
  if (r?.action === 'read') notes.push('A data source read during apply: its values are not known yet.');
  if (!attrs.length) notes.push(r?.n.same ? `${r.n.same} attribute${r.n.same === 1 ? '' : 's'}, none changed.` : 'No attributes.');
  void li;
  return `${notes.length ? `<p class="note">${notes.join(' ')}</p>` : ''}${attrs.length ? attrsHtml(key, attrs, 0) : ''}`;
}

function attrsHtml(key: string, attrs: Attr[], depth: number, parentPath = ''): string {
  const changed = attrs.filter((a) => a.kind !== 'same');
  const same = attrs.filter((a) => a.kind === 'same');
  const items = changed.map((a) => attrHtml(key, a, depth));
  const id = `${key}|${parentPath}`;
  if (same.length) {
    if (openSame.has(id) || !changed.length) items.push(...same.map((a) => attrHtml(key, a, depth)));
    else items.push(`<li class="attr more"><button class="link same-toggle" data-id="${esc(id)}" aria-expanded="false">${same.length} unchanged attribute${same.length === 1 ? '' : 's'}</button></li>`);
  }
  const hidden = attrs.length ? 0 : 0;
  void hidden;
  return `<ul class="attrs" role="list">${items.join('')}</ul>`;
}

function attrHtml(key: string, a: Attr, depth: number): string {
  const sym = a.kind === 'add' ? '+' : a.kind === 'remove' ? '-' : a.kind === 'change' ? '~' : '';
  const force = a.forcesReplacement ? `<span class="tag force" title="Changing this needs a new object">${icon('flame')} forces replacement</span>` : '';
  const enc = a.encoded ? `<span class="tag muted" title="A string holding JSON, shown as the JSON inside it">json</span>` : '';
  const block = a.block ? `<span class="tag muted">block</span>` : '';
  if (a.children && a.children.length && !(a.maskedBefore || a.maskedAfter)) {
    const n = changedCount(a);
    const hid = a.hidden ? `<span class="meta muted" title="Attributes the text output left out">${a.hidden} unchanged hidden</span>` : '';
    const meta = a.kind === 'same' ? '' : `<span class="meta">${n} change${n === 1 ? '' : 's'}</span>`;
    const id = `${key}|${a.path}`;
    const open = a.kind !== 'same' || openSame.has(id);
    return `<li class="attr k-${a.kind} has-kids${open ? '' : ' folded'}"><div class="aline"><button class="tw" aria-expanded="${open}" aria-label="${open ? 'Fold' : 'Unfold'} ${esc(a.path)}" data-path="${esc(a.path)}">${icon(open ? 'chevron-down' : 'chevron-right')}</button><span class="asym s-${a.kind}">${sym}</span><span class="akey">${esc(a.key)}</span>${block}${enc}${meta}${hid}${force}</div>${open ? attrsHtml(key, a.children, depth + 1, a.path) : ''}</li>`;
  }
  const lineWord = typeof a.before === 'string' || typeof a.after === 'string' ? ` line${a.hidden === 1 ? '' : 's'}` : '';
  const hid = a.hidden ? `<span class="meta muted" title="${lineWord ? 'Lines' : 'Attributes'} the text output left out">${a.hidden} unchanged${lineWord} hidden</span>` : '';
  return `<li class="attr k-${a.kind}"><div class="aline"><span class="asym s-${a.kind}">${sym}</span><span class="akey">${esc(a.key)}</span>${block}${enc}<span class="aval">${valueHtml(key, a)}</span>${hid}${force}</div>${multilineHtml(key, a)}</li>`;
}

function side(key: string, a: Attr, which: 'before' | 'after'): string {
  const path = a.path;
  const masked = which === 'before' ? a.maskedBefore : a.maskedAfter;
  const sensitive = which === 'before' ? a.beforeSensitive : a.afterSensitive;
  if (which === 'after' && a.afterUnknown) return `<span class="unk" title="Only known once applied">(known after apply)</span>`;
  if (masked) return `<span class="sens">(sensitive)</span><button class="icon eye" data-path="${esc(path)}" data-on="true" data-side="${which}" title="Show this sensitive value" aria-label="Reveal the ${which} value of ${esc(path)}">${icon('eye')}</button>`;
  const v = a[which];
  // A text plan prints `(sensitive value)` and nothing else: there is no value to reveal.
  if (v === undefined) return sensitive ? `<span class="sens" title="The plan doesn't hold this value">(sensitive)</span>` : '';
  if (v !== null && typeof v === 'object') return `<span class="val obj">${esc(scalarText(v, 200))}</span>`;
  const full = fullValues.has(`${key}|${path}`);
  const text = typeof v === 'string' ? JSON.stringify(v) : String(v);
  const long = text.length > LONG && !full;
  const shown = long ? text.slice(0, LONG - 1) + '…' : text;
  const cls = typeof v === 'string' ? 's' : typeof v === 'number' ? 'n' : v === null ? 'z' : 'b';
  const hide = sensitive && !masked ? `<button class="icon eye" data-path="${esc(path)}" data-on="false" data-side="${which}" title="Hide this sensitive value again" aria-label="Hide the ${which} value of ${esc(path)}">${icon('eye-closed')}</button>` : '';
  const more = long ? `<button class="link more-val" data-path="${esc(path)}" title="Show the whole value">${text.length} chars</button>` : '';
  return `<span class="val ${cls}">${esc(shown)}</span>${more}${hide}`;
}

function valueHtml(key: string, a: Attr): string {
  if (isMultiline(a.before) || isMultiline(a.after)) {
    if (!(a.maskedBefore || a.maskedAfter)) {
      const b = isMultiline(a.before) ? `${a.before.split('\n').length - (a.before.endsWith('\n') ? 1 : 0)} lines` : a.before === undefined ? '' : side(key, a, 'before');
      const n = a.afterUnknown ? side(key, a, 'after') : isMultiline(a.after) ? `${a.after.split('\n').length - (a.after.endsWith('\n') ? 1 : 0)} lines` : a.after === undefined ? '' : side(key, a, 'after');
      return a.kind === 'change' ? `<span class="muted">${b}</span><span class="arrow">${icon('arrow-right')}</span><span class="muted">${n}</span>` : `<span class="muted">${b || n}</span>`;
    }
  }
  switch (a.kind) {
    case 'add':
      return side(key, a, 'after');
    case 'remove':
      return side(key, a, 'before');
    case 'change':
      return `${side(key, a, 'before')}<span class="arrow">${icon('arrow-right')}</span>${side(key, a, 'after')}`;
    default:
      return side(key, a, a.after !== undefined || a.maskedAfter ? 'after' : 'before');
  }
}

function multilineHtml(key: string, a: Attr): string {
  void key;
  if (a.maskedBefore || a.maskedAfter) return '';
  if (!isMultiline(a.before) && !isMultiline(a.after)) return '';
  // Becoming unknown is not a removal of every line: show the current value as it is.
  if (a.afterUnknown && a.kind !== 'remove' && isMultiline(a.before)) {
    const old = a.before.endsWith('\n') ? a.before.slice(0, -1).split('\n') : a.before.split('\n');
    const max = 400;
    return `<p class="note ml-note">Current value; the new one is known after apply.</p><pre class="ml">${old.slice(0, max).map((t) => `<span class="l ms"><span class="mk"> </span>${esc(t)}\n</span>`).join('')}${old.length > max ? `… ${old.length - max} more lines` : ''}</pre>`;
  }
  const lines = lineDiff(a.kind === 'add' ? undefined : typeof a.before === 'string' ? a.before : undefined, a.kind === 'remove' || a.afterUnknown ? undefined : typeof a.after === 'string' ? a.after : undefined);
  const max = 400;
  const shown = lines.slice(0, max);
  return `<pre class="ml">${shown.map((l) => `<span class="l m${l.mark === '+' ? 'a' : l.mark === '-' ? 'd' : 's'}"><span class="mk">${l.mark}</span>${esc(l.text)}\n</span>`).join('')}${lines.length > max ? `… ${lines.length - max} more lines` : ''}</pre>`;
}

// --- outputs and checks ---------------------------------------------------------------

function outputSide(o: OutputRow, which: 'before' | 'after'): string {
  if (which === 'after' && o.afterUnknown) return `<span class="unk">(known after apply)</span>`;
  const masked = which === 'before' ? o.maskedBefore : o.maskedAfter;
  if (masked) return `<span class="sens">(sensitive)</span><button class="icon eye" data-output="${esc(o.name)}" data-side="${which}" data-on="true" title="Show this sensitive output" aria-label="Reveal output ${esc(o.name)}">${icon('eye')}</button>`;
  const v = o[which];
  if (v === undefined) return o.sensitive ? `<span class="sens" title="The plan doesn't hold this value">(sensitive)</span>` : '';
  const hide = o.sensitive ? `<button class="icon eye" data-output="${esc(o.name)}" data-side="${which}" data-on="false" title="Hide this sensitive output again" aria-label="Hide output ${esc(o.name)}">${icon('eye-closed')}</button>` : '';
  const partly = which === 'after' && o.afterPartlyUnknown ? ` <span class="unk">(parts known after apply)</span>` : '';
  return `<span class="val ${typeof v === 'string' ? 's' : 'n'}">${esc(scalarText(v, 200))}</span>${partly}${hide}`;
}

function outputsHtml(outputs: OutputRow[]): string {
  if (!outputs.length) return '';
  const changed = outputs.filter((o) => o.action !== 'no-op');
  const list = showAllOutputs ? outputs : changed;
  const same = outputs.length - changed.length;
  if (!list.length && !same) return '';
  const rows = list
    .map((o) => {
      const a = o.action === 'delete' ? 'delete' : o.action;
      return `<tr class="a-${a}"><td><span class="sym s-${a}">${a === 'create' ? '+' : a === 'delete' ? '-' : a === 'update' ? '~' : ''}</span> <code>${esc(o.name)}</code></td><td class="act">${a === 'no-op' ? 'unchanged' : ACTION_LABEL[a as Action]}</td><td>${o.action === 'create' ? '' : outputSide(o, 'before')}</td><td>${o.action === 'delete' ? '' : outputSide(o, 'after')}</td></tr>`;
    })
    .join('');
  const toggle = same ? `<button class="link" id="allOutputs" aria-pressed="${showAllOutputs}">${showAllOutputs ? 'Hide' : 'Show'} ${same} unchanged output${same === 1 ? '' : 's'}</button>` : '';
  return `<section class="outputs" id="outputs"><h2 tabindex="-1">Outputs <span class="muted">${changed.length} changed</span>${toggle}</h2>${list.length ? `<table><thead><tr><th>Output</th><th>Action</th><th>Before</th><th>After</th></tr></thead><tbody>${rows}</tbody></table>` : ''}</section>`;
}

function checksHtml(p: PlanInfo): string {
  if (!p.checks.length) return '';
  const ico: Record<string, string> = { pass: 'pass', fail: 'error', error: 'error', unknown: 'question' };
  const items = p.checks
    .map((c) => {
      const problems = c.instances.flatMap((i) => i.problems.map((m) => `<li>${esc(m)}</li>`)).join('');
      return `<li class="check st-${c.status}">${icon(ico[c.status] ?? 'question')}<code>${esc(c.address)}</code><span class="st">${c.status}</span>${c.kind !== 'check' ? `<span class="muted">${esc(c.kind === 'output_value' ? 'output' : c.kind)} condition</span>` : ''}${problems ? `<ul>${problems}</ul>` : ''}</li>`;
    })
    .join('');
  const failing = p.checks.filter((c) => c.status !== 'pass').length;
  return `<section class="checks" id="checks"><h2 tabindex="-1">Checks and conditions <span class="muted">${failing ? `${failing} not passing` : 'all passing'}</span></h2><ul>${items}</ul></section>`;
}

// --- compare mode ----------------------------------------------------------------------

function renderCompare(c: CompareInfo) {
  $('tool').innerHTML = `<span class="pill">Compare</span>`;
  $('label').textContent = `${c.a} → ${c.b}`;
  $('detail').textContent = '';
  // Copying is for a plan, not a comparison: the buttons go rather than sit disabled.
  $('copy').hidden = true;
  $('copySummary').hidden = true;
  $('openSource').hidden = true;
  const n = c.counts;
  const words: Record<string, string> = { added: 'only in the second plan', removed: 'only in the first plan', action: 'different action', attrs: 'different attribute changes', same: 'same change' };
  const chipWords = (k: keyof typeof n, k1: number): string =>
    k === 'action' ? `with ${k1 === 1 ? 'a different action' : 'different actions'}` : k === 'attrs' ? 'with different attribute changes' : k === 'same' ? `with the same change${k1 === 1 ? '' : 's'}` : words[k];
  const d = n.added + n.removed + n.action + n.attrs;
  const differences = `${d} difference${d === 1 ? '' : 's'}`;
  $('headline').innerHTML = `<div class="line">${d ? `<b>${differences}</b>` : `<span class="ok">${icon('pass')} The plans make the same changes.</span>`}<span class="muted"> · ${n.same} the same</span></div>`;
  $('summary').innerHTML = (['removed', 'added', 'action', 'attrs', 'same'] as const).filter((k) => n[k]).map((k) => `<span class="chip static st-${k}"><b>${n[k]}</b><span class="name"> ${chipWords(k, n[k])}</span></span>`).join('');
  $('cards').innerHTML = `<div class="card info">${icon('info')}<div>Each resource's planned action and attribute changes in <b>${esc(c.a)}</b> against <b>${esc(c.b)}</b>. Unchanged resources (no-op in both) are left out.</div></div>`;
  $('filter').hidden = true;
  const act = (x?: { action: Action; keys: string[] }) => (!x ? '<span class="muted">absent</span>' : x.action === 'no-op' ? `<span class="muted">${ACTION_LABEL[x.action]}</span>` : `<span class="sym s-${x.action}">${esc(actionSymbol(x.action))}</span> ${ACTION_LABEL[x.action]}`);
  const rows = c.rows
    .filter((r) => r.status !== 'same')
    .map((r) => `<li class="cmp st-${r.status}"><span class="st">${words[r.status]}</span><span class="addr">${esc(r.address)}</span><span class="ab"><span class="muted">${esc(c.a)}:</span> ${act(r.a)} <span class="muted">· ${esc(c.b)}:</span> ${act(r.b)}</span>${r.diff?.length ? `<span class="keys">${r.diff.slice(0, 8).map(esc).join(', ')}${r.diff.length > 8 ? ` +${r.diff.length - 8}` : ''}</span>` : ''}</li>`)
    .join('');
  $('main').innerHTML = rows ? `<ul class="compare" role="list">${rows}</ul>` : `<div class="empty">${icon('pass', 'ok')}<p><b>No differences.</b></p></div>`;
  $('status').textContent = differences;
}

function renderError(e: ErrorInfo) {
  $('progress').hidden = true;
  $('tool').innerHTML = '';
  $('headline').innerHTML = '';
  $('summary').innerHTML = '';
  $('filter').hidden = true;
  $<HTMLButtonElement>('copy').disabled = true;
  $<HTMLButtonElement>('copySummary').disabled = true;
  const buttons = (e.actions ?? []).map((a) => `<button class="act" data-act="${esc(a.id)}">${esc(a.label)}</button>`).join('');
  // Messages name fields and flags in backticks: shown as code, not as backticks.
  const message = esc(e.message).replace(/`([^`]+)`/g, '<code>$1</code>');
  $('cards').innerHTML = `<div class="card error big">${icon('error')}<div><b>${message}</b>${e.detail ? `<pre>${esc(e.detail)}</pre>` : ''}${buttons ? `<div class="btns">${buttons}</div>` : ''}</div></div>`;
  $('main').innerHTML = '';
  $('status').textContent = e.message.replace(/`/g, '');
}

// --- keyboard -----------------------------------------------------------------------

function items(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[role="treeitem"]')].filter((el) => !el.closest('.group.collapsed .rows'));
}

let current: string | undefined;
function setCurrent(el: HTMLElement) {
  for (const x of document.querySelectorAll<HTMLElement>('[role="treeitem"][tabindex="0"]')) if (x !== el) setStop(x, false);
  setStop(el, true);
  current = el.dataset.key ?? el.closest<HTMLElement>('.group')?.dataset.module;
}
function setStop(el: HTMLElement, on: boolean) {
  el.tabIndex = on ? 0 : -1;
  for (const b of el.querySelectorAll<HTMLElement>(':scope > .line button')) b.tabIndex = on ? 0 : -1;
}
function fixTabStop() {
  const all = items();
  const el = (current !== undefined && (document.querySelector<HTMLElement>(`.res[data-key="${CSS.escape(current)}"]`) ?? document.querySelector<HTMLElement>(`.group[data-module="${CSS.escape(current)}"] .ghead`))) || all[0];
  if (el) setCurrent(el);
}
function focusSelector(el: Element): string | undefined {
  const res = el.closest<HTMLElement>('.res');
  if (res) return `.res[data-key="${CSS.escape(res.dataset.key!)}"]`;
  const head = el.closest<HTMLElement>('.ghead');
  if (head) return `.group[data-module="${CSS.escape(head.closest<HTMLElement>('.group')!.dataset.module!)}"] .ghead`;
  if (el.id) return `#${el.id}`;
  return undefined;
}

function toggleGroup(section: HTMLElement) {
  const key = section.dataset.module!;
  const collapsed = section.classList.toggle('collapsed');
  if (collapsed) view.collapsed.add(key);
  else view.collapsed.delete(key);
  const head = section.querySelector<HTMLElement>('.ghead')!;
  head.setAttribute('aria-expanded', String(!collapsed));
  head.querySelector('.chev')!.className = `codicon codicon-chevron-${collapsed ? 'right' : 'down'} chev`;
  saveState();
}

function toggleRes(li: HTMLElement, open?: boolean) {
  const key = li.dataset.key!;
  const want = open ?? !view.expanded.has(key);
  if (want) {
    view.expanded.add(key);
    openDetail(li);
  } else {
    view.expanded.delete(key);
    closeDetail(li);
  }
  saveState();
  updateExpandButton();
}

function updateExpandButton() {
  const rows = [...document.querySelectorAll<HTMLElement>('.res[data-key]')];
  const allOpen = rows.length > 0 && rows.every((li) => view.expanded.has(li.dataset.key!));
  const b = $<HTMLButtonElement>('expand');
  b.textContent = allOpen ? 'Collapse all' : 'Expand all';
  b.disabled = !rows.length;
}

$('main').addEventListener('keydown', (e) => {
  const t = e.target as HTMLElement;
  const item = t.closest<HTMLElement>('[role="treeitem"]');
  if (!item || t.tagName === 'BUTTON' || t.tagName === 'INPUT') return;
  const isRes = item.classList.contains('res');
  const all = items();
  const i = all.indexOf(item);
  const go = (el?: HTMLElement) => {
    if (!el) return;
    setCurrent(el);
    el.focus();
    el.scrollIntoView({ block: 'nearest' });
  };
  switch (e.key) {
    case 'ArrowDown':
      go(all[i + 1]);
      break;
    case 'ArrowUp':
      go(all[i - 1]);
      break;
    case 'Home':
      go(all[0]);
      break;
    case 'End':
      go(all[all.length - 1]);
      break;
    case 'ArrowRight':
      if (isRes) {
        if (item.getAttribute('aria-expanded') !== 'true') toggleRes(item, true);
      } else if (item.getAttribute('aria-expanded') === 'false') toggleGroup(item.closest<HTMLElement>('.group')!);
      else go(all[i + 1]);
      break;
    case 'ArrowLeft':
      if (isRes) {
        if (item.getAttribute('aria-expanded') === 'true') toggleRes(item, false);
        else go(item.closest<HTMLElement>('.group')?.querySelector<HTMLElement>('.ghead') ?? undefined);
      } else if (item.getAttribute('aria-expanded') === 'true') toggleGroup(item.closest<HTMLElement>('.group')!);
      break;
    case 'Enter':
    case ' ':
      if (isRes) toggleRes(item);
      else toggleGroup(item.closest<HTMLElement>('.group')!);
      break;
    default:
      return;
  }
  e.preventDefault();
});

// --- events ---------------------------------------------------------------------------

$('main').addEventListener('click', (e) => {
  const t = e.target as HTMLElement;
  const btn = t.closest<HTMLElement>('button');
  if (btn) {
    if (btn.id === 'clearFilter') {
      view.query = '';
      search.value = '';
      view.type = '';
      view.destructiveOnly = false;
      for (const a of ACTIONS) if (a !== 'no-op') delete view.actions[a];
      saveState();
      render();
      search.focus();
      return;
    }
    if (btn.id === 'showUnchanged') {
      view.actions['no-op'] = true;
      saveState();
      render();
      (document.querySelector<HTMLElement>('.chip[data-action="no-op"]') ?? undefined)?.focus();
      return;
    }
    if (btn.id === 'allOutputs') {
      showAllOutputs = !showAllOutputs;
      render();
      return;
    }
    const li = btn.closest<HTMLElement>('.res');
    if (btn.classList.contains('jump') && li) {
      const r = rowsByKey.get(li.dataset.key!);
      if (r) post({ type: 'jump', address: r.address });
      return;
    }
    if (btn.classList.contains('eye')) {
      if (btn.dataset.output !== undefined) post({ type: 'revealOutput', name: btn.dataset.output, on: btn.dataset.on === 'true' });
      else if (li) post({ type: 'reveal', i: Number(li.dataset.i), drift: li.dataset.drift === 'true', path: btn.dataset.path!, on: btn.dataset.on === 'true' });
      return;
    }
    if (btn.classList.contains('same-toggle') && li) {
      openSame.add(btn.dataset.id!);
      redrawDetail(li);
      return;
    }
    if (btn.classList.contains('more-val') && li) {
      fullValues.add(`${li.dataset.key}|${btn.dataset.path}`);
      redrawDetail(li);
      return;
    }
    if (btn.classList.contains('tw') && li) {
      const attr = btn.closest<HTMLElement>('.attr')!;
      const id = `${li.dataset.key}|${attrPathOf(attr, li)}`;
      if (openSame.has(id)) openSame.delete(id);
      else openSame.add(id);
      // A changed container folds by removing it from the open set is not enough: it opens by kind.
      attr.classList.toggle('folded');
      const open = !attr.classList.contains('folded');
      btn.setAttribute('aria-expanded', String(open));
      btn.innerHTML = icon(open ? 'chevron-down' : 'chevron-right');
      const kids = attr.querySelector<HTMLElement>(':scope > .attrs');
      if (kids) kids.hidden = !open;
      else if (open) redrawDetail(li);
      return;
    }
    return;
  }
  const head = t.closest<HTMLElement>('.ghead');
  if (head) {
    toggleGroup(head.closest<HTMLElement>('.group')!);
    setCurrent(head);
    head.focus();
    return;
  }
  const line = t.closest<HTMLElement>('.line');
  const li = line?.closest<HTMLElement>('.res');
  if (li && !t.closest('code')) {
    if (window.getSelection()?.toString()) return;
    toggleRes(li);
    setCurrent(li);
    li.focus();
  }
});

/**
 * Draws an open resource's attributes again, keeping the keyboard focus: on the same button
 * when it is still there, else on the row (a button that was replaced would leave focus on
 * the page itself).
 */
function redrawDetail(li: HTMLElement) {
  const a = document.activeElement as HTMLElement | null;
  const inside = !!a && a !== li && li.contains(a);
  let sel: string | undefined;
  if (inside && a.dataset.path !== undefined) {
    const cls = ['eye', 'tw', 'more-val'].find((c) => a.classList.contains(c));
    if (cls) sel = `button.${cls}[data-path="${CSS.escape(a.dataset.path)}"]${a.dataset.side ? `[data-side="${a.dataset.side}"]` : ''}`;
  }
  openDetail(li, false);
  if (!inside) return;
  ((sel ? li.querySelector<HTMLElement>(sel) : null) ?? li).focus();
}

/** The path of an attribute element, from its key chain. */
function attrPathOf(attr: HTMLElement, li: HTMLElement): string {
  const key = li.dataset.key!;
  const attrs = details.get(key) ?? [];
  const chain: string[] = [];
  let el: HTMLElement | null = attr;
  while (el && el !== li) {
    if (el.classList.contains('attr')) chain.unshift(el.querySelector('.akey')?.textContent ?? '');
    el = el.parentElement;
  }
  let list = attrs;
  let found: Attr | undefined;
  for (const k of chain) {
    found = list.find((a) => a.key === k);
    if (!found) return chain.join('.');
    list = found.children ?? [];
  }
  return found?.path ?? chain.join('.');
}

$('main').addEventListener('focusin', (e) => {
  const item = (e.target as HTMLElement).closest<HTMLElement>('[role="treeitem"]');
  if (item) setCurrent(item);
});

$('summary').addEventListener('click', (e) => {
  const chip = (e.target as HTMLElement).closest<HTMLElement>('.chip[data-action]');
  if (!chip) return;
  const a = chip.dataset.action!;
  if (a === 'no-op') view.actions[a] = !showNoop();
  else view.actions[a] = view.actions[a] === false;
  saveState();
  render();
  (document.querySelector(`.chip[data-action="${a}"]`) as HTMLElement | null)?.focus();
});

$('headline').addEventListener('click', (e) => {
  const a = (e.target as HTMLElement).closest<HTMLAnchorElement>('a[href^="#"]');
  if (!a) return;
  e.preventDefault();
  const target = document.getElementById(a.getAttribute('href')!.slice(1));
  if (!target) return;
  target.scrollIntoView({ block: 'start', behavior: 'smooth' });
  // Keyboard and screen reader users go there too: the drift group's header, or the heading.
  const to = target.querySelector<HTMLElement>(':scope > .ghead, :scope > h2');
  if (to?.classList.contains('ghead')) setCurrent(to);
  to?.focus({ preventScroll: true });
});

let typing: ReturnType<typeof setTimeout> | undefined;
search.addEventListener('input', () => {
  clearTimeout(typing);
  typing = setTimeout(() => {
    view.query = search.value;
    saveState();
    render();
  }, 120);
});
$<HTMLSelectElement>('typeFilter').addEventListener('change', (e) => {
  view.type = (e.target as HTMLSelectElement).value;
  saveState();
  render();
});
$('destructive').addEventListener('click', () => {
  view.destructiveOnly = !view.destructiveOnly;
  saveState();
  render();
  $('destructive').focus();
});
$('expand').addEventListener('click', () => {
  const rows = [...document.querySelectorAll<HTMLElement>('.res[data-key]')];
  const allOpen = rows.every((li) => view.expanded.has(li.dataset.key!));
  for (const li of rows) toggleRes(li, !allOpen);
});
$('copy').addEventListener('click', () => post({ type: 'copyMarkdown' }));
$('copySummary').addEventListener('click', () => post({ type: 'copySummary' }));
$('openSource').addEventListener('click', () => post({ type: 'openSource' }));
$('reload').addEventListener('click', () => post({ type: 'reload' }));
$('cards').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('button.act');
  if (b) post({ type: 'action', id: b.dataset.act! });
});

document.addEventListener('keydown', (e) => {
  if (e.key === '/' && document.activeElement !== search && !(document.activeElement instanceof HTMLInputElement)) {
    search.focus();
    e.preventDefault();
  } else if (e.key === 'Escape' && document.activeElement === search && search.value) {
    search.value = '';
    search.dispatchEvent(new Event('input'));
  }
});

// --- host messages ---------------------------------------------------------------------

window.addEventListener('message', (e: MessageEvent<ToWebview>) => {
  const m = e.data;
  switch (m.type) {
    case 'loading':
      $('progress').hidden = false;
      $('status').textContent = 'Loading…';
      if (m.label && !compare) $('label').textContent = m.label;
      if (!plan && !compare) {
        $('main').innerHTML = `<p class="loading">Reading the plan…</p>`;
      }
      break;
    case 'plan':
      $('progress').hidden = true;
      plan = m.plan;
      compare = undefined;
      rowsByKey = new Map([...plan.rows.map((r) => [keyOf(r, false), r] as [string, Row]), ...plan.drift.map((r) => [keyOf(r, true), r] as [string, Row])]);
      details.clear();
      requested.clear();
      // The showUnchanged setting was changed: it wins over the chip's last state again.
      if (lastSetting !== undefined && lastSetting !== plan.showUnchanged) delete view.actions['no-op'];
      lastSetting = plan.showUnchanged;
      // Rows that are gone (a rewritten plan) are no longer remembered as open.
      for (const k of [...view.expanded]) if (!rowsByKey.has(k)) view.expanded.delete(k);
      saveState();
      render();
      break;
    case 'compare':
      $('progress').hidden = true;
      compare = m.compare;
      plan = undefined;
      renderCompare(compare);
      break;
    case 'error':
      plan = undefined;
      renderError(m.error);
      break;
    case 'detail': {
      const row = plan && (m.drift ? plan.drift : plan.rows).find((r) => r.i === m.i);
      if (!row) break;
      const key = keyOf(row, m.drift);
      details.set(key, m.attrs);
      const li = document.querySelector<HTMLElement>(`.res[data-key="${CSS.escape(key)}"]`);
      if (li && view.expanded.has(key)) redrawDetail(li);
      break;
    }
    case 'outputs':
      if (plan) {
        plan.outputs = m.outputs;
        const sec = document.getElementById('outputs');
        if (sec) {
          // Keep the focus on the eye button that was pressed, in the new table.
          const a = document.activeElement as HTMLElement | null;
          const was = a && sec.contains(a) ? a : undefined;
          sec.outerHTML = outputsHtml(plan.outputs);
          if (was) {
            const out = document.getElementById('outputs');
            const again = was.dataset.output !== undefined ? out?.querySelector<HTMLElement>(`button.eye[data-output="${CSS.escape(was.dataset.output)}"][data-side="${was.dataset.side ?? 'after'}"]`) : undefined;
            (again ?? out?.querySelector<HTMLElement>('h2'))?.focus();
          }
        }
      }
      break;
    case 'persist':
      persist = m.state;
      saveState();
      break;
    case 'view':
      if (m.view.actions) Object.assign(view.actions, m.view.actions);
      if (m.view.query !== undefined) search.value = view.query = m.view.query;
      if (m.view.typeFilter !== undefined) view.type = m.view.typeFilter;
      if (m.view.destructiveOnly !== undefined) view.destructiveOnly = m.view.destructiveOnly;
      if (m.view.expanded) view.expanded = new Set(m.view.expanded);
      if (m.view.collapsed) view.collapsed = new Set(m.view.collapsed);
      if (plan) render();
      break;
  }
});

post({ type: 'ready' });

export {};
void (null as unknown as Value);
