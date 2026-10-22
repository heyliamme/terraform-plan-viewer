// Renders the real view outside VS Code, for UI work, with a plan file of either kind.
//
//   npm run build
//   node harness/preview.mjs test/fixtures/real/changes.json
//   google-chrome --headless=new --window-size=1280,900 --screenshot=out/dark.png "file://$PWD/out/preview.html?theme=dark"
//
// Query parameters: theme=dark|light.
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const core = createRequire(import.meta.url)(path.join(root, 'dist/core.js'));
const [file = 'test/fixtures/real/changes.json'] = process.argv.slice(2);
const read = (f) => readFileSync(path.resolve(f), 'utf8');

const THEMES = {
  dark: `--vscode-font-family:-apple-system,"Segoe UI",Ubuntu,sans-serif;--vscode-font-size:13px;--vscode-foreground:#cccccc;--vscode-editor-foreground:#cccccc;--vscode-editor-background:#1f1f1f;--vscode-panel-border:#2b2b2b;--vscode-list-hoverBackground:#2a2d2e;--vscode-input-background:#313131;--vscode-focusBorder:#0078d4;--vscode-descriptionForeground:#9d9d9d;--vscode-button-background:#0078d4;--vscode-button-foreground:#fff;--vscode-button-secondaryBackground:#313131;--vscode-button-secondaryHoverBackground:#3c3c3c;--vscode-button-secondaryForeground:#cccccc;--vscode-editor-font-family:"Cascadia Code","DejaVu Sans Mono",Menlo,monospace;--vscode-textLink-foreground:#4daafc;--vscode-dropdown-background:#313131;--vscode-dropdown-foreground:#cccccc;`,
  light: `--vscode-font-family:-apple-system,"Segoe UI",Ubuntu,sans-serif;--vscode-font-size:13px;--vscode-foreground:#3b3b3b;--vscode-editor-foreground:#3b3b3b;--vscode-editor-background:#ffffff;--vscode-panel-border:#e5e5e5;--vscode-list-hoverBackground:#f2f2f2;--vscode-input-background:#ffffff;--vscode-focusBorder:#005fb8;--vscode-descriptionForeground:#717171;--vscode-button-background:#005fb8;--vscode-button-foreground:#fff;--vscode-button-secondaryBackground:#e5e5e5;--vscode-button-secondaryHoverBackground:#cccccc;--vscode-button-secondaryForeground:#3b3b3b;--vscode-editor-font-family:"Cascadia Code","DejaVu Sans Mono",Menlo,monospace;--vscode-textLink-foreground:#005fb8;--vscode-dropdown-background:#ffffff;--vscode-dropdown-foreground:#3b3b3b;`,
};

const plan = core.parsePlan(read(file));
const row = (r, i) => ({ i, address: r.address, module: r.module, mode: r.mode, type: r.type, name: r.name, action: r.action, order: r.replaceOrder, reason: r.reason, prev: r.previousAddress, importId: r.importId, deposed: r.deposed, forces: r.forces, keys: r.changedKeys, n: r.n, unparsed: r.unparsed?.length });
const info = {
  label: path.basename(file),
  detail: file,
  source: 'file',
  kind: plan.source,
  flavor: plan.flavor,
  version: plan.terraformVersion,
  timestamp: plan.timestamp,
  errored: plan.errored,
  planLine: plan.planLine,
  counts: plan.counts,
  summary: core.summaryLine(plan.counts),
  rows: plan.resources.map(row),
  drift: plan.drift.map(row),
  outputs: plan.outputs.map((o) => ({ name: o.name, action: o.action, before: o.beforeSensitive ? undefined : o.before, after: o.afterSensitive ? undefined : o.after, afterUnknown: o.afterUnknown, maskedBefore: o.beforeSensitive && o.before !== undefined, maskedAfter: o.afterSensitive && o.after !== undefined, sensitive: o.beforeSensitive || o.afterSensitive })),
  checks: plan.checks,
  diagnostics: plan.diagnostics,
  notes: plan.notes,
  unparsed: plan.unparsed,
  canJump: true,
  canOpenSource: true,
  masked: true,
  destructiveFirst: true,
  showUnchanged: false,
  ms: plan.ms,
};
const details = { r: plan.resources.map((r) => core.maskAttrs(r.attrs)), d: plan.drift.map((r) => core.maskAttrs(r.attrs)) };

const html = `<!doctype html><html><head><meta charset="utf-8">
<style>:root{${THEMES.dark}} :root.light{${THEMES.light}}</style>
<link rel="stylesheet" href="codicon.css">
<style>${read(path.join(root, 'dist/webview.css'))}</style></head>
<body><div id="app"></div>
<script>
const q = new URLSearchParams(location.search);
if (q.get('theme') === 'light') { document.documentElement.classList.add('light'); document.body.className = 'vscode-light'; }
else document.body.className = 'vscode-dark';
const info = ${JSON.stringify(info).replace(/</g, '\\u003c')};
const details = ${JSON.stringify(details).replace(/</g, '\\u003c')};
window.acquireVsCodeApi = () => ({ setState: () => {}, getState: () => undefined, postMessage: (m) => {
  console.log('host <-', JSON.stringify(m).slice(0, 200));
  if (m.type === 'ready') setTimeout(() => window.postMessage({ type: 'plan', plan: info }, '*'));
  if (m.type === 'detail') setTimeout(() => window.postMessage({ type: 'detail', i: m.i, drift: m.drift, attrs: details[m.drift ? 'd' : 'r'][m.i] }, '*'));
}});
</script>
<script>${read(path.join(root, 'dist/webview.js'))}</script>
</body></html>`;

mkdirSync(path.join(root, 'out'), { recursive: true });
writeFileSync(path.join(root, 'out/preview.html'), html);
for (const f of ['codicon.css', 'codicon.ttf']) writeFileSync(path.join(root, 'out', f), readFileSync(path.join(root, 'dist', f)));
console.log(path.join(root, 'out/preview.html'));
