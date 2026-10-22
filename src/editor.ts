// The custom editor for plan files: .tfplan (the default editor for those), and plan JSON
// or text files through "Reopen Editor With…".
import * as path from 'path';
import * as vscode from 'vscode';
import { PlanView } from './view';

export const EDITOR_TYPE = 'terraformPlanViewer.plan';
export const BINARY_EDITOR_TYPE = 'terraformPlanViewer.binary';

class PlanDocument implements vscode.CustomDocument {
  constructor(public readonly uri: vscode.Uri) {}
  dispose() {}
}

export class PlanEditorProvider implements vscode.CustomReadonlyEditorProvider<PlanDocument> {
  constructor(private readonly extensionUri: vscode.Uri) {}

  static register(context: vscode.ExtensionContext): vscode.Disposable[] {
    const provider = new PlanEditorProvider(context.extensionUri);
    const options = { webviewOptions: { retainContextWhenHidden: true }, supportsMultipleEditorsPerDocument: true };
    return [vscode.window.registerCustomEditorProvider(EDITOR_TYPE, provider, options), vscode.window.registerCustomEditorProvider(BINARY_EDITOR_TYPE, provider, options)];
  }

  openCustomDocument(uri: vscode.Uri): PlanDocument {
    return new PlanDocument(uri);
  }

  async resolveCustomEditor(document: PlanDocument, panel: vscode.WebviewPanel): Promise<void> {
    const uri = document.uri;
    const label = path.basename(uri.path);
    const rel = vscode.workspace.asRelativePath(uri, true);
    const view = new PlanView(panel.webview, this.extensionUri, { kind: 'file', label, detail: rel === label ? undefined : rel, uri });
    panel.onDidDispose(() => view.dispose());
    await view.load();
  }
}
