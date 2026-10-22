import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { BinaryError, runPlan } from './binary';
import { decodeText, detectPlan, DETECT_TEXT_BYTES, looksLikeBinaryPlan } from './core';
import { BINARY_EDITOR_TYPE, EDITOR_TYPE, PlanEditorProvider } from './editor';
import { ComparePanel, PANEL_TYPE, PlanPanel } from './panel';

const PLAN_FILE = /\.(tfplan|plan|json|txt|log)$/i;
const PLAN_LANGS = new Set(['json', 'jsonc', 'plaintext', 'log', 'terraform-plan', 'tfplan']);

export function activate(context: vscode.ExtensionContext) {
  const command = (id: string, fn: (...args: any[]) => unknown) =>
    vscode.commands.registerCommand(id, async (...args: any[]) => {
      try {
        await fn(...args);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (e instanceof BinaryError && (e.why === 'restricted' || e.why === 'cancelled')) vscode.window.showInformationMessage(msg);
        else vscode.window.showErrorMessage(`Terraform Plan Viewer: ${msg}`);
      }
    });

  /** The file a command acts on: the one it was invoked on, else the active editor's or viewer's. */
  const target = (uri?: unknown): vscode.Uri | undefined => {
    if (uri instanceof vscode.Uri) return uri;
    const doc = vscode.window.activeTextEditor?.document;
    if (doc) return doc.uri;
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    if (tab instanceof vscode.TabInputCustom || tab instanceof vscode.TabInputText) return tab.uri;
    return undefined;
  };

  const openUri = async (uri: vscode.Uri) => {
    // An unsaved editor, or one with unsaved changes: the text as shown, in a panel (the
    // viewer of a file reads what is on disk).
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
    if (doc?.isUntitled || doc?.isDirty) {
      const label = doc.isUntitled ? doc.uri.path : `${path.basename(doc.uri.path)} (unsaved)`;
      PlanPanel.show(context.extensionUri, { kind: 'editor', label, text: doc.getText(), editor: doc.uri });
      return;
    }
    let binary = /(?:\.|\/)tfplan$/i.test(uri.path);
    if (!binary && uri.scheme === 'file') binary = looksLikeBinaryPlan(await readHead(uri, 4).catch(() => new Uint8Array()));
    await vscode.commands.executeCommand('vscode.openWith', uri, binary ? BINARY_EDITOR_TYPE : EDITOR_TYPE);
  };

  context.subscriptions.push(
    ...PlanEditorProvider.register(context),
    vscode.window.registerWebviewPanelSerializer(PANEL_TYPE, {
      deserializeWebviewPanel: (panel, state) => PlanPanel.revive(context.extensionUri, panel, state),
    }),

    command('terraformPlanViewer.open', async (uri?: vscode.Uri) => {
      const u = target(uri);
      if (!u) {
        vscode.window.showInformationMessage('Open a plan file first: plan JSON, a .tfplan, or the text output of terraform plan.');
        return;
      }
      await openUri(u);
    }),

    command('terraformPlanViewer.openFile', async () => {
      const picked = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { 'Terraform plans': ['tfplan', 'json', 'txt', 'log', 'plan'], 'All files': ['*'] }, title: 'Open a Terraform or OpenTofu plan' });
      if (picked?.[0]) await openUri(picked[0]);
    }),

    command('terraformPlanViewer.openClipboard', async () => {
      const text = await vscode.env.clipboard.readText();
      if (!text.trim()) {
        vscode.window.showInformationMessage('The clipboard is empty. Copy a plan (JSON, or the output of terraform plan, colour codes and all) first.');
        return;
      }
      PlanPanel.show(context.extensionUri, { kind: 'clipboard', label: 'Clipboard', text });
    }),

    command('terraformPlanViewer.runPlan', async (uri?: vscode.Uri) => {
      if (!vscode.workspace.isTrusted) throw new BinaryError('Run Plan needs a trusted workspace: no Terraform or OpenTofu binary runs in Restricted Mode.', 'restricted');
      const dir = uri instanceof vscode.Uri ? uri : await pickFolder();
      if (!dir) return;
      if (dir.scheme !== 'file') throw new Error('Run Plan needs a folder on a local disk.');
      const label = vscode.workspace.asRelativePath(dir, true) || path.basename(dir.fsPath);
      const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Planning ${label}`, cancellable: true }, (progress, token) => runPlan(dir.fsPath, 'unknown', token, (message) => progress.report({ message })));
      PlanPanel.show(context.extensionUri, { kind: 'run', label: `${label}`, detail: `${result.binary.name} plan, ${new Date().toLocaleTimeString()}`, text: result.json, dir });
    }),

    command('terraformPlanViewer.compare', async (uri?: vscode.Uri) => {
      const a = target(uri);
      if (!a) {
        vscode.window.showInformationMessage('Open a plan file first.');
        return;
      }
      const b = await pickPlanFile(a);
      if (b) ComparePanel.show(context.extensionUri, a, b);
    }),

    command('terraformPlanViewer.compareSelected', async (uri?: vscode.Uri, uris?: vscode.Uri[]) => {
      const files = uris?.length ? uris : uri ? [uri] : [];
      if (files.length !== 2) {
        vscode.window.showInformationMessage('Select exactly two plan files in the Explorer.');
        return;
      }
      ComparePanel.show(context.extensionUri, files[0], files[1]);
    }),
  );

  // The title button, menu entries and shortcut show for files that look like a plan.
  // `isPlan` follows the active editor (shortcut, editor menu); `planFiles` lists every
  // visible editor holding a plan, so each editor group's title bar goes by its own file.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const seen = new Map<string, { version: number; isPlan: boolean }>();
  const looksLikePlan = (doc: vscode.TextDocument): boolean => {
    const k = doc.uri.toString();
    const hit = seen.get(k);
    if (hit?.version === doc.version) return hit.isPlan;
    let isPlan = false;
    if (PLAN_FILE.test(doc.uri.path) || PLAN_LANGS.has(doc.languageId) || doc.isUntitled) {
      // A CI log can hold megabytes of other output before its plan.
      const head = doc.getText(new vscode.Range(new vscode.Position(0, 0), doc.positionAt(DETECT_TEXT_BYTES)));
      isPlan = detectPlan(head) !== undefined;
    }
    seen.set(k, { version: doc.version, isPlan });
    return isPlan;
  };
  let lastActive: boolean | undefined;
  let lastFiles = '';
  const updateContext = () => {
    const active = vscode.window.activeTextEditor?.document;
    const isPlan = !!active && looksLikePlan(active);
    if (lastActive !== isPlan) void vscode.commands.executeCommand('setContext', 'terraformPlanViewer.isPlan', isPlan);
    lastActive = isPlan;
    const visible = new Set(vscode.window.visibleTextEditors.map((e) => e.document));
    if (active) visible.add(active);
    const files = [...new Set([...visible].filter(looksLikePlan).map((d) => d.uri.fsPath))].sort();
    const joined = files.join('\n');
    if (joined !== lastFiles) void vscode.commands.executeCommand('setContext', 'terraformPlanViewer.planFiles', files);
    lastFiles = joined;
    // Forget documents that are closed.
    const open = new Set(vscode.workspace.textDocuments.map((d) => d.uri.toString()));
    for (const k of seen.keys()) if (!open.has(k)) seen.delete(k);
  };
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(updateContext),
    vscode.window.onDidChangeVisibleTextEditors(updateContext),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (!vscode.window.visibleTextEditors.some((x) => x.document === e.document)) return;
      clearTimeout(timer);
      timer = setTimeout(updateContext, 500);
    }),
    { dispose: () => clearTimeout(timer) },
  );
  updateContext();
  setTimeout(updateContext, 300);
}

/** A folder with .tf files to plan in: the workspace folder, or one of its subfolders. */
async function pickFolder(): Promise<vscode.Uri | undefined> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (!folders.length) {
    vscode.window.showInformationMessage('Open a folder with Terraform files first.');
    return undefined;
  }
  const found = await vscode.workspace.findFiles('**/*.{tf,tofu}', '{**/node_modules/**,**/.terraform/**,**/.git/**,**/vendor/**,**/modules/**}', 2000);
  // The folders as URIs of the workspace's own scheme: in a virtual workspace they are not
  // local paths, and Run Plan says so instead of running in a folder that doesn't exist.
  const byKey = new Map<string, vscode.Uri>();
  for (const u of found) {
    const d = vscode.Uri.joinPath(u, '..');
    byKey.set(d.toString(), d);
  }
  const dirs = [...byKey.values()].sort((a, b) => a.toString().localeCompare(b.toString()));
  if (dirs.length === 1) return dirs[0];
  if (!dirs.length) {
    vscode.window.showInformationMessage('No .tf files were found in the workspace.');
    return undefined;
  }
  const items = dirs.map((d) => ({ label: `$(folder) ${vscode.workspace.asRelativePath(d, true) || path.basename(d.path)}`, description: d.scheme === 'file' ? d.fsPath : d.toString(), d }));
  const pick = await vscode.window.showQuickPick(items, { title: 'Run plan in which folder?', placeHolder: 'A folder with .tf files; terraform init must have run there' });
  return pick?.d;
}

/** The first bytes of a file, without reading all of it when it is on a local disk. */
async function readHead(u: vscode.Uri, n: number): Promise<Uint8Array> {
  if (u.scheme === 'file') {
    const fh = await fs.promises.open(u.fsPath, 'r');
    try {
      const buf = Buffer.alloc(n);
      const { bytesRead } = await fh.read(buf, 0, n, 0);
      return buf.subarray(0, bytesRead);
    } finally {
      await fh.close();
    }
  }
  const st = await vscode.workspace.fs.stat(u);
  if (st.size > 8 * 1024 * 1024) throw new Error('too large to read for a look');
  return (await vscode.workspace.fs.readFile(u)).subarray(0, n);
}

async function isPlanFile(u: vscode.Uri): Promise<boolean> {
  try {
    const st = await vscode.workspace.fs.stat(u);
    if (!(st.type & vscode.FileType.File)) return false;
    // JSON tells from its first keys; a text log may need a few megabytes.
    const bytes = await readHead(u, /\.json$/i.test(u.path) ? 64 * 1024 : DETECT_TEXT_BYTES);
    if (looksLikeBinaryPlan(bytes)) return /(?:\.(?:tfplan|plan)|\/tfplan)$/i.test(u.path);
    return detectPlan(decodeText(bytes)) !== undefined;
  } catch {
    return false;
  }
}

/** Another plan file in the workspace, to compare with. */
async function pickPlanFile(exclude: vscode.Uri): Promise<vscode.Uri | undefined> {
  type Item = vscode.QuickPickItem & { uri?: vscode.Uri; browse?: boolean };
  const qp = vscode.window.createQuickPick<Item>();
  qp.title = 'Compare with which plan?';
  qp.placeholder = 'Another plan (JSON or text) in the workspace, or browse';
  qp.matchOnDescription = true;
  qp.busy = true;
  const browse: Item = { label: '$(folder-opened) Browse…', browse: true, alwaysShow: true };
  const items: Item[] = [];
  qp.items = [browse];
  qp.show();
  const cancel = new vscode.CancellationTokenSource();
  const scan = (async () => {
    const found = await vscode.workspace.findFiles('**/{*.json,*.txt,*.log,*.plan,*.tfplan,tfplan}', '{**/node_modules/**,**/.git/**,**/.terraform/**,**/dist/**,**/out/**}', 3000, cancel.token);
    found.sort((a, b) => a.path.localeCompare(b.path));
    for (let i = 0; i < found.length && !cancel.token.isCancellationRequested; i += 8) {
      const batch = found.slice(i, i + 8).filter((u) => u.toString() !== exclude.toString());
      const ok = await Promise.all(batch.map(isPlanFile));
      batch.forEach((u, j) => {
        if (!ok[j]) return;
        const rel = vscode.workspace.asRelativePath(u);
        items.push({ label: `$(file) ${path.basename(u.path)}`, description: rel === path.basename(u.path) ? undefined : rel, uri: u });
        qp.items = [...items, { label: '', kind: vscode.QuickPickItemKind.Separator }, browse];
      });
    }
  })();
  scan.catch(() => undefined).finally(() => (qp.busy = false));
  const picked = await new Promise<Item | undefined>((resolve) => {
    qp.onDidAccept(() => resolve(qp.selectedItems[0]));
    qp.onDidHide(() => resolve(undefined));
  });
  cancel.cancel();
  cancel.dispose();
  qp.dispose();
  if (!picked) return undefined;
  if (picked.browse) {
    const r = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { 'Terraform plans': ['json', 'txt', 'log', 'plan', 'tfplan'], 'All files': ['*'] } });
    return r?.[0];
  }
  return picked.uri;
}

export function deactivate() {}
