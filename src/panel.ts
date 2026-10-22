// Panels for plans that aren't a file on disk: the clipboard, an unsaved editor, a plan
// just run; and the comparison of two plans. After a window reload a panel comes back for
// a file; one opened from the clipboard, an unsaved editor or a run says so and offers to
// read it again, because plan content is never stored.
import * as path from 'path';
import * as vscode from 'vscode';
import { allowFolder, BinaryError, requireBinaryAllowed, showJson, type Flavor } from './binary';
import { comparePlans, decodeText, looksLikeBinaryPlan, parsePlan, type Plan } from './core';
import { inspectBinaryPlan } from './core/tfplan';
import { isFromWebview, type CompareInfo, type ErrorInfo, type ToWebview, type ViewState } from './protocol';
import { editorText, MAX_BYTES, PlanView, watchFile, webviewHtml, webviewOptions, type PlanSource } from './view';

export const PANEL_TYPE = 'terraformPlanViewer';

interface PanelState {
  kind: 'plan' | 'compare';
  source?: { kind: PlanSource['kind']; label: string; detail?: string; uri?: string; dir?: string; editor?: string };
  a?: string;
  b?: string;
  view?: ViewState;
}

export class PlanPanel {
  private static open = new Set<PlanPanel>();
  private view?: PlanView;

  static show(extensionUri: vscode.Uri, source: PlanSource): PlanPanel {
    // One panel per file or unsaved editor; the clipboard and runs get a new one each time.
    const keyOf = (s: PlanSource) => (s.uri ?? (s.kind === 'editor' ? s.editor : undefined))?.toString();
    const key = keyOf(source);
    if (key) {
      for (const p of PlanPanel.open) {
        if (p.view && keyOf(p.view.source) === key) {
          if (source.kind === 'editor') p.view.source = source;
          p.panel.reveal();
          void p.view.load();
          return p;
        }
      }
    }
    const panel = vscode.window.createWebviewPanel(PANEL_TYPE, `Plan: ${source.label}`, vscode.ViewColumn.Active, { ...webviewOptions(extensionUri), retainContextWhenHidden: true });
    return new PlanPanel(extensionUri, panel, source);
  }

  static async revive(extensionUri: vscode.Uri, panel: vscode.WebviewPanel, state: unknown): Promise<void> {
    const kept = (state ?? {}) as { persist?: PanelState; view?: ViewState };
    const saved = kept.persist;
    if (saved?.kind === 'compare' && saved.a && saved.b) {
      new ComparePanel(extensionUri, panel, vscode.Uri.parse(saved.a), vscode.Uri.parse(saved.b));
      return;
    }
    const s = saved?.source;
    if (!s) {
      panel.dispose();
      return;
    }
    const source: PlanSource = { kind: s.kind, label: s.label, detail: s.detail };
    if (s.uri) source.uri = vscode.Uri.parse(s.uri);
    if (s.dir) source.dir = vscode.Uri.parse(s.dir);
    if (s.editor) source.editor = vscode.Uri.parse(s.editor);
    const p = new PlanPanel(extensionUri, panel, source, kept.view);
    if (!source.uri) p.gone();
  }

  private constructor(
    extensionUri: vscode.Uri,
    private readonly panel: vscode.WebviewPanel,
    source: PlanSource,
    view?: ViewState,
  ) {
    this.panel.iconPath = vscode.Uri.joinPath(extensionUri, 'media', 'icon.png');
    this.view = new PlanView(this.panel.webview, extensionUri, source, {
      setTitle: (t) => (this.panel.title = `Plan: ${t}`),
      persist: () => this.persist(),
    });
    this.view.restoreView(view);
    PlanPanel.open.add(this);
    this.panel.onDidDispose(() => {
      PlanPanel.open.delete(this);
      this.view?.dispose();
    });
    if (source.uri || source.text !== undefined) void this.view.load();
  }

  private persist(): PanelState {
    const s = this.view!.source;
    const out: PanelState = { kind: 'plan', source: { kind: s.kind, label: s.label, detail: s.detail } };
    if (s.uri) out.source!.uri = s.uri.toString();
    if (s.dir) out.source!.dir = s.dir.toString();
    if (s.editor) out.source!.editor = s.editor.toString();
    return out;
  }

  /** The source was the clipboard, an unsaved editor or a run: its content was not kept across the reload. */
  private gone() {
    const s = this.view!.source;
    const error: ErrorInfo =
      s.kind === 'run'
        ? { message: `This view showed a plan run in ${s.label.replace(/^Plan: /, '')}. Plan output isn't stored, so it is gone after the window reloaded.`, actions: [{ id: 'run', label: 'Run the Plan Again' }] }
        : s.kind === 'editor'
          ? { message: `This view showed the plan in the unsaved editor ${s.label}. Plan content isn't stored, so it is gone after the window reloaded.`, actions: s.editor ? [{ id: 'editor', label: 'Read the Editor Again' }] : [] }
          : { message: "This view showed a plan from the clipboard. Plan content isn't stored, so it is gone after the window reloaded.", actions: [{ id: 'clipboard', label: 'Read the Clipboard Again' }] };
    // The view posts the error once the webview says it is ready.
    (this.view as unknown as { lastError?: ErrorInfo }).lastError = error;
  }
}

/** Two plans side by side: what changed between the runs. */
export class ComparePanel {
  private disposables: vscode.Disposable[] = [];
  private ready = false;
  private disposed = false;
  /** Each load's number: only the latest one posts what it read. */
  private generation = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private loading?: vscode.CancellationTokenSource;
  /** A folder outside the workspace `show` would run in, waiting for the person's word. */
  private blockedFolder?: string;

  static show(extensionUri: vscode.Uri, a: vscode.Uri, b: vscode.Uri) {
    const panel = vscode.window.createWebviewPanel(PANEL_TYPE, `Compare plans: ${path.basename(a.path)} → ${path.basename(b.path)}`, vscode.ViewColumn.Active, { ...webviewOptions(extensionUri), retainContextWhenHidden: true });
    return new ComparePanel(extensionUri, panel, a, b);
  }

  constructor(
    extensionUri: vscode.Uri,
    private readonly panel: vscode.WebviewPanel,
    private readonly a: vscode.Uri,
    private readonly b: vscode.Uri,
  ) {
    panel.iconPath = vscode.Uri.joinPath(extensionUri, 'media', 'icon.png');
    panel.webview.options = webviewOptions(extensionUri);
    panel.webview.html = webviewHtml(panel.webview, extensionUri);
    panel.webview.onDidReceiveMessage((m: unknown) => void this.onMessage(m), null, this.disposables);
    panel.onDidDispose(() => {
      this.disposed = true;
      clearTimeout(this.timer);
      this.loading?.cancel();
      for (const d of this.disposables.splice(0)) d.dispose();
    });
    // A rewrite comes as several change events, or as a create when a tool writes a temporary
    // file and renames it: read again once it has settled.
    const again = () => {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => void this.load(), 500);
    };
    const watch = (u: vscode.Uri) => {
      if (u.scheme === 'file') this.disposables.push(watchFile(u, again));
    };
    watch(a);
    watch(b);
  }

  private post(m: ToWebview) {
    if (this.ready && !this.disposed) void this.panel.webview.postMessage(m);
  }

  private async read(u: vscode.Uri, token: vscode.CancellationToken): Promise<Plan> {
    // An open editor with unsaved text (or no file at all): what the person sees.
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === u.toString());
    if (doc && (doc.isUntitled || doc.isDirty)) return parsePlan(doc.getText());
    if (u.scheme === 'untitled') {
      const text = await editorText(u);
      if (text === undefined) throw new Error(`${u.path} is no longer open.`);
      return parsePlan(text);
    }
    const st = await vscode.workspace.fs.stat(u);
    if (st.size > MAX_BYTES) throw new Error(`${path.basename(u.path)} is ${Math.round(st.size / 1024 / 1024)} MB; the limit is ${MAX_BYTES / 1024 / 1024} MB.`);
    const bytes = await vscode.workspace.fs.readFile(u);
    if (looksLikeBinaryPlan(bytes)) {
      if (u.scheme !== 'file') throw new Error('a binary plan can only be read from a local disk, in the folder it was planned in.');
      requireBinaryAllowed(u.fsPath);
      const info = inspectBinaryPlan(bytes);
      const { json } = await showJson(u.fsPath, info.flavor as Flavor, token);
      return parsePlan(json, 'json');
    }
    return parsePlan(decodeText(bytes));
  }

  private async load() {
    if (this.disposed) return;
    const gen = ++this.generation;
    this.loading?.cancel();
    const cts = (this.loading = new vscode.CancellationTokenSource());
    this.post({ type: 'loading', label: 'Comparing…' });
    try {
      // Both plans are held at once: the limit is on the two together.
      const sizes = await Promise.all([this.a, this.b].map((u) => (u.scheme === 'untitled' ? 0 : Promise.resolve(vscode.workspace.fs.stat(u)).then((s) => s.size, () => 0))));
      if (sizes[0] + sizes[1] > MAX_BYTES) throw new Error(`together the two files are ${Math.round((sizes[0] + sizes[1]) / 1024 / 1024)} MB; the limit is ${MAX_BYTES / 1024 / 1024} MB.`);
      const [pa, pb] = await Promise.all([this.read(this.a, cts.token), this.read(this.b, cts.token)]);
      if (gen !== this.generation || this.disposed) return;
      const c = comparePlans(pa, pb);
      const info: CompareInfo = { a: path.basename(this.a.path), b: path.basename(this.b.path), counts: c.counts, rows: c.rows };
      this.post({ type: 'compare', compare: info });
      this.post({ type: 'persist', state: { kind: 'compare', a: this.a.toString(), b: this.b.toString() } satisfies PanelState });
    } catch (e) {
      if (gen !== this.generation || this.disposed) return;
      const actions: ErrorInfo['actions'] = [];
      if (e instanceof BinaryError && e.why === 'restricted') actions.push({ id: 'trust', label: 'Manage Workspace Trust' });
      if (e instanceof BinaryError && e.why === 'outside' && e.folder) {
        this.blockedFolder = e.folder;
        actions.push({ id: 'allowRun', label: 'Trust This Folder and Read It' });
      }
      actions.push({ id: 'reload', label: 'Try Again' });
      this.post({ type: 'error', error: { message: `The plans could not be compared: ${e instanceof Error ? e.message : String(e)}`, actions } });
    }
  }

  private async onMessage(m: unknown) {
    if (!isFromWebview(m) || this.disposed) return;
    if (m.type === 'ready') {
      this.ready = true;
      this.post({ type: 'persist', state: { kind: 'compare', a: this.a.toString(), b: this.b.toString() } satisfies PanelState });
      await this.load();
    } else if (m.type === 'reload' || (m.type === 'action' && m.id === 'reload')) await this.load();
    else if (m.type === 'action' && m.id === 'trust') await vscode.commands.executeCommand('workbench.trust.manage');
    else if (m.type === 'action' && m.id === 'allowRun') {
      if (this.blockedFolder) allowFolder(this.blockedFolder);
      await this.load();
    } else if (m.type === 'jump') {
      const { jumpTo } = await import('./hcl');
      await jumpTo(m.address);
    }
  }
}
