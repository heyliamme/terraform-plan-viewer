// The view of one plan: reads the source (a file, text or a binary plan), keeps the parsed
// plan on this side, and answers the webview's requests. Shared by the custom editor and
// the panels. Plan content never leaves memory: nothing is written, logged or sent.
import { randomBytes } from 'crypto';
import * as path from 'path';
import * as vscode from 'vscode';
import { allowFolder, BinaryError, requireBinaryAllowed, runPlan, SECTION, showJson, type Flavor } from './binary';
import { decodeText, looksLikeBinaryPlan, maskAttrs, NotAPlan, parsePlan, PlanJsonError, summaryLine, toMarkdown, toSummary, type Attr, type Plan, type ResourceChange } from './core';
import { inspectBinaryPlan } from './core/tfplan';
import { jumpTo } from './hcl';
import { isFromWebview, type CheckRow, type ErrorInfo, type OutputRow, type PlanInfo, type Row, type SourceKind, type ToWebview, type ViewState } from './protocol';

export interface PlanSource {
  kind: 'file' | 'clipboard' | 'run' | 'editor';
  label: string;
  detail?: string;
  /** A file to read (and watch). */
  uri?: vscode.Uri;
  /** Text held in memory: the clipboard, a plan run, an unsaved editor. */
  text?: string;
  /** For a plan run: the folder, to run it again. */
  dir?: vscode.Uri;
  /** For an unsaved editor: its document, to read it again. */
  editor?: vscode.Uri;
}

/**
 * Calls `changed` when a file is written or created again. The name is not used as a glob
 * (`plan[prod].json` would be a character class): the folder is watched and events are
 * matched on the exact path.
 */
export function watchFile(uri: vscode.Uri, changed: () => void): vscode.Disposable {
  const name = path.basename(uri.fsPath);
  const plain = !/[[\]{}*?!]/.test(name);
  const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.joinPath(uri, '..'), plain ? name : '*'));
  const on = (u: vscode.Uri) => {
    if (u.fsPath === uri.fsPath) changed();
  };
  return vscode.Disposable.from(w, w.onDidChange(on), w.onDidCreate(on));
}

/**
 * Above this many bytes a file is refused rather than read. The plan is parsed on the
 * extension host: 150 MB of plan JSON takes about 6 s and 1 GB of heap, which is as far as it
 * is sensible to block every other extension.
 */
export const MAX_BYTES = 150 * 1024 * 1024;

export interface ViewHost {
  setTitle?(title: string): void;
  /** For the serializer: what identifies the source, never its content. */
  persist?(): unknown;
}

export function webviewHtml(w: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = randomBytes(16).toString('hex');
  const asset = (f: string) => w.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', f));
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${w.cspSource}; script-src 'nonce-${nonce}'; font-src ${w.cspSource}; img-src ${w.cspSource};">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${asset('codicon.css')}">
<link rel="stylesheet" href="${asset('webview.css')}">
<title>Terraform Plan</title>
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${asset('webview.js')}"></script>
</body>
</html>`;
}

export const webviewOptions = (extensionUri: vscode.Uri): vscode.WebviewOptions => ({ enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist')] });

/** Settings for a plan: folder settings apply to a file in that folder. */
const settings = (uri?: vscode.Uri) => vscode.workspace.getConfiguration(SECTION, uri);

/** The text of an open (or restorable) editor's document, or undefined when it is gone. */
export async function editorText(uri: vscode.Uri): Promise<string | undefined> {
  const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
  if (open) return open.getText();
  // After a reload an unsaved editor's tab is back before its document is: opening the
  // untitled URI of a tab that isn't there would make a new, empty one.
  const inTab = vscode.window.tabGroups.all.some((g) => g.tabs.some((t) => t.input instanceof vscode.TabInputText && t.input.uri.toString() === uri.toString()));
  if (uri.scheme === 'untitled' && !inTab) return undefined;
  try {
    return (await vscode.workspace.openTextDocument(uri)).getText();
  } catch {
    return undefined;
  }
}

function rowOf(r: ResourceChange, i: number): Row {
  const row: Row = { i, address: r.address, module: r.module, mode: r.mode, type: r.type, name: r.name, action: r.action, forces: r.forces, keys: r.changedKeys, n: r.n };
  if (r.replaceOrder) row.order = r.replaceOrder;
  if (r.reason) row.reason = r.reason;
  if (r.previousAddress) row.prev = r.previousAddress;
  if (r.importId !== undefined) row.importId = r.importId;
  if (r.importIdUnknown) row.importIdUnknown = true;
  if (r.deposed) row.deposed = r.deposed;
  if (r.unparsed?.length) row.unparsed = r.unparsed.length;
  return row;
}

export class PlanView {
  private plan?: Plan;
  private sourceKind: SourceKind;
  private ready = false;
  private disposed = false;
  private disposables: vscode.Disposable[] = [];
  private revealed = new Map<string, Set<string>>();
  private revealedOutputs = new Set<string>();
  private lastError?: ErrorInfo;
  private timer?: ReturnType<typeof setTimeout>;
  private loading?: vscode.CancellationTokenSource;
  private view?: ViewState;
  /** Which binary read the plan, for the header. */
  private binaryName?: string;
  /** A folder outside the workspace `show` would run in, waiting for the person's word. */
  private blockedFolder?: string;

  constructor(
    private readonly webview: vscode.Webview,
    private readonly extensionUri: vscode.Uri,
    public source: PlanSource,
    private readonly host: ViewHost = {},
  ) {
    this.sourceKind = source.kind === 'file' ? 'file' : source.kind;
    webview.options = webviewOptions(extensionUri);
    webview.html = webviewHtml(webview, extensionUri);
    webview.onDidReceiveMessage((m: unknown) => void this.onMessage(m), null, this.disposables);
    if (source.uri?.scheme === 'file') {
      this.disposables.push(
        watchFile(source.uri, () => {
          clearTimeout(this.timer);
          this.timer = setTimeout(() => void this.load(), 500);
        }),
      );
    }
    vscode.workspace.onDidChangeConfiguration(
      (e) => {
        if (e.affectsConfiguration(SECTION, this.source.uri) && this.plan) this.send();
      },
      null,
      this.disposables,
    );
    vscode.workspace.onDidGrantWorkspaceTrust(() => this.lastError?.actions?.some((a) => a.id === 'trust') && void this.load(), null, this.disposables);
  }

  /** The view's remembered filters, from a serializer. */
  restoreView(view: ViewState | undefined) {
    this.view = view;
  }

  private post(m: ToWebview) {
    if (this.ready && !this.disposed) void this.webview.postMessage(m);
  }

  async load(): Promise<void> {
    if (this.disposed) return;
    this.loading?.cancel();
    const cts = (this.loading = new vscode.CancellationTokenSource());
    this.post({ type: 'loading', label: this.source.label });
    this.lastError = undefined;
    try {
      const plan = await this.read(cts.token);
      if (cts.token.isCancellationRequested || this.disposed) return;
      this.plan = plan;
      this.revealed.clear();
      this.revealedOutputs.clear();
      this.send();
    } catch (e) {
      if (cts.token.isCancellationRequested || this.disposed) return;
      this.plan = undefined;
      this.lastError = this.describe(e);
      this.post({ type: 'error', error: this.lastError });
    }
  }

  private describe(e: unknown): ErrorInfo {
    if (e instanceof BinaryError) {
      const actions: ErrorInfo['actions'] = [];
      if (e.why === 'restricted') actions.push({ id: 'trust', label: 'Manage Workspace Trust' });
      if (e.why === 'outside' && e.folder) {
        this.blockedFolder = e.folder;
        actions.push({ id: 'allowRun', label: 'Trust This Folder and Read It' });
        return { message: e.message, actions };
      }
      if (e.why === 'notFound') actions.push({ id: 'settings', label: 'Open Settings' });
      actions.push({ id: 'reload', label: 'Try Again' });
      const info: ErrorInfo = { message: e.message, actions };
      if (e.detail) info.detail = e.detail;
      return info;
    }
    if (e instanceof NotAPlan || e instanceof PlanJsonError) return { message: e.message, actions: this.source.kind === 'clipboard' ? [{ id: 'clipboard', label: 'Read the Clipboard Again' }] : [{ id: 'reload', label: 'Try Again' }] };
    return { message: `The plan could not be read: ${e instanceof Error ? e.message : String(e)}`, actions: [{ id: 'reload', label: 'Try Again' }] };
  }

  private async read(token: vscode.CancellationToken): Promise<Plan> {
    const t0 = Date.now();
    let text: string;
    this.binaryName = undefined;
    if (this.source.uri) {
      const st = await vscode.workspace.fs.stat(this.source.uri);
      if (st.size > MAX_BYTES) throw new Error(`the file is ${Math.round(st.size / 1024 / 1024)} MB; the limit is ${MAX_BYTES / 1024 / 1024} MB.`);
      const bytes = await vscode.workspace.fs.readFile(this.source.uri);
      if (looksLikeBinaryPlan(bytes)) {
        if (this.source.uri.scheme !== 'file') throw new Error('a binary plan can only be read from a local disk, in the folder it was planned in.');
        requireBinaryAllowed(this.source.uri.fsPath);
        const info = inspectBinaryPlan(bytes);
        const { json, binary } = await showJson(this.source.uri.fsPath, info.flavor as Flavor, token);
        this.sourceKind = 'binary';
        this.binaryName = binary.name;
        const plan = parsePlan(json, 'json');
        plan.notes.unshift(`Read with ${path.basename(binary.cmd)} show -json${info.version ? ` (the plan was written by ${info.flavor === 'opentofu' ? 'OpenTofu' : info.flavor === 'terraform' ? 'Terraform' : 'a tool'} ${info.version})` : ''}.`);
        plan.ms = Date.now() - t0;
        return plan;
      }
      text = decodeText(bytes);
      this.sourceKind = 'file';
    } else {
      // An unsaved editor is read again each time: Reload shows what it holds now.
      if (this.source.kind === 'editor' && this.source.editor) {
        const fresh = await editorText(this.source.editor);
        if (fresh !== undefined) this.source = { ...this.source, text: fresh };
      }
      text = this.source.text ?? '';
    }
    if (!text.trim()) throw new NotAPlan(this.source.kind === 'clipboard' ? 'The clipboard is empty.' : 'The file is empty.');
    const plan = parsePlan(text);
    plan.ms = Date.now() - t0;
    return plan;
  }

  private info(): PlanInfo {
    const p = this.plan!;
    const masked = settings(this.source.uri).get<boolean>('maskSensitive') !== false;
    const outputs: OutputRow[] = p.outputs.map((o) => {
      const row: OutputRow = { name: o.name, action: o.action };
      const show = !masked || this.revealedOutputs.has(o.name);
      if (o.beforeSensitive || o.afterSensitive) row.sensitive = true;
      if (o.before !== undefined) {
        if (o.beforeSensitive && !show) row.maskedBefore = true;
        else row.before = o.before;
      }
      if (o.after !== undefined) {
        if (o.afterSensitive && !show) row.maskedAfter = true;
        else row.after = o.after;
      }
      if (o.afterUnknown) row.afterUnknown = true;
      if (o.afterPartlyUnknown) row.afterPartlyUnknown = true;
      return row;
    });
    const checks: CheckRow[] = p.checks.map((c) => ({ address: c.address, kind: c.kind, status: c.status, instances: c.instances.map((i) => ({ address: i.address, status: i.status, problems: i.problems })) }));
    const folders = vscode.workspace.workspaceFolders ?? [];
    const label = this.source.label;
    const notes = [...p.notes];
    if (this.source.kind === 'run' && this.source.dir) notes.unshift(`Planned in ${vscode.workspace.asRelativePath(this.source.dir, true)}. Nothing was written; the plan lives in this view only.`);
    return {
      label,
      detail: this.source.detail,
      source: this.sourceKind,
      kind: p.source,
      flavor: p.flavor,
      version: p.terraformVersion,
      formatVersion: p.formatVersion,
      timestamp: p.timestamp,
      errored: p.errored,
      planLine: p.planLine,
      counts: p.counts,
      summary: summaryLine(p.counts),
      rows: p.resources.map(rowOf),
      drift: p.drift.map(rowOf),
      outputs,
      checks,
      diagnostics: p.diagnostics,
      notes,
      unparsed: p.unparsed.slice(0, 200),
      canJump: folders.length > 0,
      canOpenSource: !!this.source.uri && this.sourceKind !== 'binary',
      canCompare: !!(this.source.uri ?? this.source.editor),
      masked,
      destructiveFirst: settings(this.source.uri).get<boolean>('destructiveFirst') !== false,
      showUnchanged: settings(this.source.uri).get<boolean>('showUnchanged') === true,
      ms: p.ms,
    };
  }

  private send() {
    if (!this.plan) return;
    const info = this.info();
    this.host.setTitle?.(`${info.label}`);
    this.post({ type: 'plan', plan: info });
    this.post({ type: 'persist', state: this.host.persist?.() });
  }

  private resource(i: number, drift: boolean): ResourceChange | undefined {
    const list = drift ? this.plan?.drift : this.plan?.resources;
    return list?.[i];
  }

  private detail(i: number, drift: boolean) {
    const r = this.resource(i, drift);
    if (!r) return;
    const masked = settings(this.source.uri).get<boolean>('maskSensitive') !== false;
    const attrs: Attr[] = masked ? maskAttrs(r.attrs, this.revealed.get(`${drift ? 'd' : 'r'}${i}`)) : r.attrs;
    this.post({ type: 'detail', i, drift, attrs });
  }

  private async onMessage(m: unknown) {
    if (!isFromWebview(m) || this.disposed) return;
    try {
      switch (m.type) {
        case 'ready':
          this.ready = true;
          // What the serializer needs, before anything else: a view that only ever shows an
          // error still comes back after a reload.
          this.post({ type: 'persist', state: this.host.persist?.() });
          if (this.view) this.post({ type: 'view', view: this.view });
          // The label first, so the header names the plan whatever comes next.
          this.post({ type: 'loading', label: this.source.label });
          if (this.plan) this.send();
          else if (this.lastError) this.post({ type: 'error', error: this.lastError });
          break;
        case 'detail':
          this.detail(m.i, m.drift);
          break;
        case 'reveal': {
          const key = `${m.drift ? 'd' : 'r'}${m.i}`;
          const set = this.revealed.get(key) ?? new Set<string>();
          if (m.on) set.add(m.path);
          else set.delete(m.path);
          this.revealed.set(key, set);
          this.detail(m.i, m.drift);
          break;
        }
        case 'revealOutput':
          if (m.on) this.revealedOutputs.add(m.name);
          else this.revealedOutputs.delete(m.name);
          if (this.plan) this.post({ type: 'outputs', outputs: this.info().outputs });
          break;
        case 'copyMarkdown':
          if (!this.plan) return;
          await vscode.env.clipboard.writeText(toMarkdown(this.plan, { title: this.source.label }));
          vscode.window.setStatusBarMessage('$(check) Copied the plan as Markdown (sensitive values masked)', 3000);
          break;
        case 'copySummary':
          if (!this.plan) return;
          await vscode.env.clipboard.writeText(toSummary(this.plan, this.source.label));
          vscode.window.setStatusBarMessage('$(check) Copied the plan summary', 3000);
          break;
        case 'jump':
          await jumpTo(m.address);
          break;
        case 'openSource':
          if (this.source.uri) {
            const doc = await vscode.workspace.openTextDocument(this.source.uri);
            await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: true });
          }
          break;
        case 'reload':
          await this.load();
          break;
        case 'action':
          await this.action(m.id);
          break;
        case 'compare': {
          const uri = this.source.uri ?? this.source.editor;
          if (uri) await vscode.commands.executeCommand('terraformPlanViewer.compare', uri);
          break;
        }
      }
    } catch (e) {
      if (!this.disposed) vscode.window.showErrorMessage(`Terraform Plan Viewer: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async action(id: string) {
    switch (id) {
      case 'trust':
        await vscode.commands.executeCommand('workbench.trust.manage');
        break;
      case 'settings':
        await vscode.commands.executeCommand('workbench.action.openSettings', `${SECTION}.binaryPath`);
        break;
      case 'reload':
        await this.load();
        break;
      case 'clipboard':
        this.source = { ...this.source, text: await vscode.env.clipboard.readText() };
        await this.load();
        break;
      case 'run': {
        // Run again into this view, rather than a new one next to it.
        const dir = this.source.dir;
        if (!dir) break;
        const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Planning ${this.source.label}`, cancellable: true }, (progress, token) => runPlan(dir.fsPath, 'unknown', token, (message) => progress.report({ message })));
        if (this.disposed) break;
        this.source = { ...this.source, text: result.json, detail: `${result.binary.name} plan, ${new Date().toLocaleTimeString()}` };
        await this.load();
        break;
      }
      case 'editor': {
        const text = this.source.editor ? await editorText(this.source.editor) : undefined;
        if (text === undefined) {
          this.lastError = { message: `${this.source.label} is no longer open, so its plan can't be read again.` };
          this.post({ type: 'error', error: this.lastError });
          break;
        }
        this.source = { ...this.source, text };
        await this.load();
        break;
      }
      case 'allowRun':
        if (this.blockedFolder) allowFolder(this.blockedFolder);
        await this.load();
        break;
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.timer);
    this.loading?.cancel();
    for (const d of this.disposables.splice(0)) d.dispose();
    this.plan = undefined;
  }
}
