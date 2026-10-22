// End-to-end: installs the packaged extension into a throwaway VS Code profile, opens a
// workspace with Terraform files and plans of every kind (JSON, a CI log with colour
// codes, a binary .tfplan), and uses the extension the way a person would: the title
// button, Reopen With, the Explorer menu, the clipboard, a plan run, comparing plans,
// filters, details, masking, jump to HCL, the keyboard, Copy as Markdown, Reload Window.
// Then it opens a copy of the workspace again, untrusted, to check Restricted Mode.
// A stub `tofu` stands in for the real binary, so the run is the same everywhere.
// Linux, with `code` on PATH.
//
//   npm run package && node test/e2e/run.mjs [terraform-plan-viewer-x.y.z.vsix]
//   E2E_SHOTS=images node test/e2e/run.mjs   # also writes the README screenshots there
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { VSCode, waitFor } from './vscode.mjs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const vsix = path.resolve(process.argv[2] || `${pkg.name}-${pkg.version}.vsix`);
if (!existsSync(vsix)) throw new Error(`${vsix} not found: run npm run package first`);
const shotsFor = process.env.E2E_SHOTS ? path.resolve(process.env.E2E_SHOTS) : undefined;

const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'terraform-plan-viewer-e2e-')));
const ws = path.join(root, 'workspace');
const out = path.join(root, 'shots');
const bin = path.join(root, 'bin');
for (const d of [path.join(ws, 'infra', 'modules', 'child'), path.join(ws, 'plans'), out, bin]) mkdirSync(d, { recursive: true });
const fixtures = path.resolve('test/fixtures');
copyFileSync(path.join('samples', 'infra', 'main.tf'), path.join(ws, 'infra', 'main.tf'));
copyFileSync(path.join('samples', 'infra', 'versions.tf'), path.join(ws, 'infra', 'versions.tf'));
copyFileSync(path.join('samples', 'infra', 'modules', 'child', 'main.tf'), path.join(ws, 'infra', 'modules', 'child', 'main.tf'));
copyFileSync(path.join(fixtures, 'real', 'changes.json'), path.join(ws, 'plans', 'changes.json'));
copyFileSync(path.join(fixtures, 'real', 'replace.json'), path.join(ws, 'plans', 'replace.json'));
copyFileSync(path.join(fixtures, 'real', 'sensitive.json'), path.join(ws, 'plans', 'sensitive.json'));
copyFileSync(path.join(fixtures, 'real', 'changes.plan.ansi.txt'), path.join(ws, 'plans', 'ci-output.log'));
copyFileSync(path.join(fixtures, 'real', 'sensitive.plan.txt'), path.join(ws, 'plans', 'sensitive-plan.log'));
copyFileSync(path.join(fixtures, 'real', 'changes.tfplan'), path.join(ws, 'plans', 'changes.tfplan'));
writeFileSync(path.join(ws, 'plans', 'notes.json'), JSON.stringify({ name: 'not a plan', items: [1, 2] }, null, 2));
// A stand-in for tofu: `show -json` answers with the fixture, `plan -out` writes a file.
copyFileSync(path.join(fixtures, 'real', 'changes.json'), path.join(bin, 'changes.json'));
copyFileSync(path.join(fixtures, 'real', 'changes.tfplan'), path.join(bin, 'changes.tfplan'));
const calls = path.join(bin, 'calls.log');
writeFileSync(
  path.join(bin, 'tofu'),
  `#!/bin/sh
echo "$(pwd) :: $*" >> "${calls}"
case "$1" in
  show) cat "${path.join(bin, 'changes.json')}" ;;
  plan) out=""; for a in "$@"; do case "$a" in -out=*) out="\${a#-out=}";; esac; done
        echo "random_pet.server: Refreshing state... [id=open-reptile]"; sleep 1
        echo "Plan: 1 to import, 6 to add, 1 to change, 7 to destroy, 1 to forget."
        cp "${path.join(bin, 'changes.tfplan')}" "$out" ;;
  *) echo "OpenTofu v1.13.1" ;;
esac
`,
);
chmodSync(path.join(bin, 'tofu'), 0o755);
// A binary a workspace might try to point the extension at: it must never run.
const evilMarker = path.join(root, 'evil-ran');
writeFileSync(path.join(bin, 'evil'), `#!/bin/sh\ntouch "${evilMarker}"\ncat "${path.join(bin, 'changes.json')}"\n`);
chmodSync(path.join(bin, 'evil'), 0o755);
mkdirSync(path.join(ws, '.vscode'), { recursive: true });
writeFileSync(path.join(ws, '.vscode', 'settings.json'), JSON.stringify({ 'terraformPlanViewer.binaryPath': path.join(bin, 'evil') }, null, 2));

const settings = {
  'security.workspace.trust.enabled': false,
  'workbench.startupEditor': 'none',
  'workbench.colorTheme': 'Default Dark Modern',
  'window.restoreWindows': 'none',
  'git.openRepositoryInParentFolders': 'never',
  'extensions.autoUpdate': false,
  'telemetry.telemetryLevel': 'off',
  'chat.disableAIFeatures': true,
  'window.dialogStyle': 'custom',
  'workbench.tips.enabled': false,
  'editor.minimap.enabled': false,
  'editor.autoClosingQuotes': 'never',
  'editor.autoClosingBrackets': 'never',
  'editor.formatOnType': false,
  'editor.autoIndent': 'none',
  'workbench.secondarySideBar.defaultVisibility': 'hidden',
  'workbench.editor.enablePreview': false,
  // Menus in the page, so the Explorer's context menu can be clicked; a click only selects.
  'window.menuStyle': 'custom',
  'workbench.list.openMode': 'doubleClick',
  'terraformPlanViewer.binaryPath': path.join(bin, 'tofu'),
};
let vs = new VSCode(root);
vs.install(vsix, settings);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
const failed = [];
async function step(name, fn) {
  const t = Date.now();
  try {
    if (await vs.quickInputVisible().catch(() => false)) await vs.key('Escape');
    await fn();
    passed++;
    console.log(`  ✓ ${name} (${Date.now() - t} ms)`);
  } catch (e) {
    failed.push(name);
    const file = path.join(out, `${failed.length}-${name.replace(/\W+/g, '-')}.png`);
    await vs.screenshot(file).catch(() => {});
    console.log(`  ✗ ${name}\n      ${String(e.message).split('\n').join('\n      ')}\n      screenshot: ${file}`);
  }
}
const ok = (cond, msg) => {
  if (!cond) throw new Error(msg);
};
const eq = (a, b, what) => ok(JSON.stringify(a) === JSON.stringify(b), `${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);

// In the webview.
const W = {
  headline: `document.querySelector('#headline .line')?.textContent ?? ''`,
  chips: `Object.fromEntries([...document.querySelectorAll('.chip[data-action]')].map((c) => [c.dataset.action, +c.querySelector('b').textContent]))`,
  rows: `[...document.querySelectorAll('.res')].map((r) => r.querySelector('.addr').textContent)`,
  cards: `document.getElementById('cards').textContent`,
  row: (addr) => `[...document.querySelectorAll('.res')].find((r) => r.querySelector('.addr').textContent === ${JSON.stringify(addr)})`,
  click: (sel) => `(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) throw new Error('not found: ' + ${JSON.stringify(sel)}); e.click(); return true; })()`,
};
let ctx;
const w = (expr) => vs.eval(expr, ctx);
const until = (expr, what, timeout) => waitFor(() => w(expr), { what, timeout });

async function focusWorkbench() {
  await vs.clickElement(`document.querySelector('.part.sidebar .composite.title')`);
}
async function openFile(name) {
  if (await vs.quickInputVisible()) await vs.key('Escape');
  await focusWorkbench();
  await vs.key('p', { ctrl: true });
  await waitFor(() => vs.quickInputVisible(), { what: 'quick open' });
  await vs.type(name);
  await sleep(700);
  await vs.key('Enter');
  const base = name.split('/').pop();
  await waitFor(async () => (await vs.editorTabs()).some((t) => t.startsWith(base)), { what: `${name} to open` });
  await sleep(400);
}
async function focusEditor() {
  await vs.clickElement(`document.querySelector('.editor-group-container.active .editor-instance .monaco-editor .view-lines')`);
  await sleep(150);
}
async function shotOfEditor(file) {
  const r = await vs.eval(`(() => { const b = document.querySelector('.part.editor').getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height }; })()`);
  const { data } = await vs.send('Page.captureScreenshot', { format: 'png', clip: { ...r, scale: 1 } });
  writeFileSync(file, Buffer.from(data, 'base64'));
}
async function closeAll() {
  await focusWorkbench();
  await vs.key('k', { ctrl: true });
  await vs.key('w', { ctrl: true });
  await waitFor(async () => (await vs.editorTabs()).length === 0, { what: 'editors to close' });
}
async function paletteRun(title) {
  if (await vs.quickInputVisible()) await vs.key('Escape');
  await waitFor(async () => !(await vs.quickInputVisible()), { what: 'quick input to close' });
  await vs.key('F1');
  await waitFor(async () => (await vs.quickInputVisible()) && (await vs.quickInputValue()).startsWith('>'), { what: 'command palette' });
  await vs.type(title);
  await sleep(500);
  await vs.key('Enter');
  await sleep(600);
}
async function statusBarSelection() {
  return vs.eval(`document.querySelector('[id="status.editor.selection"]')?.textContent ?? ''`);
}
async function newUntitled() {
  await focusWorkbench();
  await vs.key('n', { ctrl: true });
  await waitFor(async () => (await vs.editorTabs()).some((t) => /^Untitled-\d+$/.test(t)), { what: 'untitled editor' });
  await sleep(300);
}
async function setClipboard(text) {
  await newUntitled();
  await vs.type(text);
  await vs.key('a', { ctrl: true });
  await vs.key('c', { ctrl: true });
  await sleep(200);
  await vs.command('View: Revert and Close Editor');
}
async function editorText() {
  return vs.eval(`[...document.querySelectorAll('.editor-group-container.active .editor-instance .view-lines .view-line')].sort((a, b) => parseFloat(a.style.top) - parseFloat(b.style.top)).map((l) => l.textContent).join('\\n').replace(/\\u00a0/g, ' ')`);
}
async function quickItems() {
  return vs.eval(`[...document.querySelectorAll('.quick-input-widget .monaco-list-row')].map((r) => (r.getAttribute('aria-label') || r.textContent).trim())`);
}
const titleButton = `document.querySelector('.editor-group-container.active .editor-actions [aria-label^="Open as Terraform Plan"]')`;
/** Opens the active file in the viewer with the title button and waits for the webview. */
async function openInViewer(file, label = file.split('/').pop()) {
  await openFile(file);
  // VS Code reopens a file with the editor it was last shown in: maybe the viewer already.
  const already = await vs.webview(label, 1500).catch(() => undefined);
  if (already) ctx = already;
  else {
    await waitFor(() => vs.eval(`!!${titleButton}`), { what: 'the title button' });
    await vs.clickElement(titleButton);
    ctx = await vs.webview(label);
  }
  await until(`${W.headline}.length > 0`, 'the headline');
}
/** Right-clicks a file in the Explorer and picks a menu item. */
async function explorerMenu(file, item, extra = []) {
  await vs.command('View: Show Explorer');
  const row = (n) => `[...document.querySelectorAll('.explorer-folders-view .monaco-list-row')].find((r) => r.textContent.trim() === ${JSON.stringify(n)})`;
  const folder = 'plans';
  await waitFor(() => vs.eval(`!!${row(folder)}`), { what: 'the plans folder' });
  if (!(await vs.eval(`!!${row(file)}`))) await vs.clickElement(row(folder));
  await waitFor(() => vs.eval(`!!${row(file)}`), { what: `${file} in the Explorer` });
  await vs.clickElement(row(file));
  for (const f of extra) {
    const box = await vs.eval(`(() => { const r = ${row(f)}.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    for (const type of ['mousePressed', 'mouseReleased']) await vs.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1, modifiers: 2 });
  }
  await vs.clickElement(row(extra[extra.length - 1] ?? file), 'right');
  const entry = `[...document.querySelectorAll('.context-view .action-item')].find((x) => x.textContent.includes(${JSON.stringify(item)}))`;
  await waitFor(() => vs.eval(`!!${entry}`), { what: `${item} in the context menu` });
  await vs.clickElement(entry);
}

try {
  console.log(`VS Code profile: ${root}`);
  await vs.launch(ws);
  await sleep(2000);

  await step('the title button opens plan JSON in the viewer, destructive changes first', async () => {
    await openInViewer('plans/changes.json');
    const headline = await w(W.headline);
    ok(headline.startsWith('3 to add, 1 to change, 4 to destroy, 3 to replace, 1 to import, 4 moved, 1 to forget, 2 to read'), headline);
    eq(await w(W.chips), { delete: 4, replace: 3, create: 3, update: 1, import: 1, move: 4, forget: 1, read: 2, 'no-op': 7 }, 'chips');
    const rows = await w(W.rows);
    ok(rows[0] === 'local_file.notes["a"]', `drift first: ${rows[0]}`);
    ok(await w(`document.querySelector('.group.drift')?.textContent.includes('Changed outside of OpenTofu')`), 'drift section');
    const root = await w(`[...document.querySelectorAll('.group:not(.drift) .res')].slice(0, 4).map((r) => r.classList.contains('a-delete') || r.classList.contains('a-replace'))`);
    eq(root, [true, true, true, true], 'the loud ones first');
    ok(!(rows.includes('random_pet.server')), 'no-ops hidden by default');
    ok(await w(`!!document.querySelector('.tag.force')`), 'forces replacement tag');
    ok(await w(`document.getElementById('tool').textContent.includes('OpenTofu 1.13.1')`), 'tool badge');
    ok((await vs.editorTabs()).some((t) => t.startsWith('changes.json')), 'the tab');
  });

  await step('opening a resource shows its attribute diff, with unchanged ones folded', async () => {
    await w(`${W.row('local_file.config')}.querySelector('.line').click()`);
    await until(`${W.row('local_file.config')}.querySelector('.attrs .attr')`, 'attributes');
    const text = await w(`${W.row('local_file.config')}.querySelector('.detail').textContent`);
    ok(text.includes('env') && text.includes('"staging"') && text.includes('"production"'), text.slice(0, 300));
    ok(text.includes('(known after apply)'), 'unknown values');
    ok(text.includes('forces replacement'), 'the forcing attribute is marked');
    ok(text.includes('json'), 'the jsonencode value is opened up');
    ok(/\d+ unchanged attributes/.test(text), 'unchanged attributes folded');
    await w(`[...${W.row('local_file.config')}.querySelectorAll('.same-toggle')].pop().click()`);
    await until(`${W.row('local_file.config')}.querySelector('.detail').textContent.includes('directory_permission')`, 'unchanged attributes shown');
    eq(await w(`${W.row('local_file.config')}.getAttribute('aria-expanded')`), 'true', 'aria-expanded');
  });

  if (shotsFor) {
    mkdirSync(shotsFor, { recursive: true });
    await w(`window.scrollTo(0, 0)`);
    await sleep(400);
    await shotOfEditor(path.join(shotsFor, 'plan-dark.png'));
  }

  await step('chips, the type list, destructive only and search filter the tree', async () => {
    const before = (await w(W.rows)).length;
    await w(W.click('.chip[data-action="create"]'));
    await until(`${W.rows}.length === ${before - 3}`, 'creates hidden');
    eq(await w(`document.querySelector('.chip[data-action="create"]').getAttribute('aria-pressed')`), 'false', 'pressed state');
    await w(W.click('.chip[data-action="create"]'));
    await until(`${W.rows}.length === ${before}`, 'creates back');
    await w(W.click('#destructive'));
    await until(`[...document.querySelectorAll('.group:not(.drift) .res')].every((r) => r.classList.contains('a-delete') || r.classList.contains('a-replace'))`, 'only destructive');
    await w(W.click('#destructive'));
    await w(`(() => { const s = document.getElementById('typeFilter'); s.value = 'null_resource'; s.dispatchEvent(new Event('change')); })()`);
    await until(`${W.rows}.every((a) => a.includes('null_resource'))`, 'one type');
    await w(`(() => { const s = document.getElementById('typeFilter'); s.value = ''; s.dispatchEvent(new Event('change')); })()`);
    await w(`(() => { const s = document.getElementById('search'); s.value = 'cbd triggers'; s.dispatchEvent(new Event('input')); })()`);
    await until(`${W.rows}.length === 1 && ${W.rows}[0] === 'null_resource.cbd'`, 'search by address and a changed attribute');
    await w(`(() => { const s = document.getElementById('search'); s.value = 'nothing-like-this'; s.dispatchEvent(new Event('input')); })()`);
    await until(`!!document.getElementById('clearFilter')`, 'empty state');
    await w(W.click('#clearFilter'));
    await until(`${W.rows}.length === ${before}`, 'filter cleared');
    eq(await w(`document.activeElement?.id`), 'search', 'focus on the search box');
  });

  await step('keyboard: arrows move through groups and resources, Enter opens, Left folds', async () => {
    await w(`document.querySelector('.group:not(.drift) .res').focus()`);
    const key = (k) => w(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k)}, bubbles: true }))`);
    eq(await w(`document.activeElement.tabIndex`), 0, 'the focused row is the tab stop');
    eq(await w(`document.querySelectorAll('[role="treeitem"][tabindex="0"]').length`), 1, 'one tab stop');
    const first = await w(`document.activeElement.querySelector('.addr').textContent`);
    await key('ArrowDown');
    ok(await w(`document.activeElement.classList.contains('res') && document.activeElement.querySelector('.addr').textContent !== ${JSON.stringify('')}`), 'next row');
    await key('ArrowUp');
    eq(await w(`document.activeElement.querySelector('.addr').textContent`), first, 'ArrowUp comes back');
    const addr = first;
    if ((await w(`${W.row(addr)}.getAttribute('aria-expanded')`)) === 'true') await key('Enter');
    await key('Enter');
    await until(`${W.row(addr)}.getAttribute('aria-expanded') === 'true'`, 'opened with Enter');
    await key('ArrowLeft');
    eq(await w(`${W.row(addr)}.getAttribute('aria-expanded')`), 'false', 'folded with Left');
    await key('ArrowLeft');
    ok(await w(`document.activeElement.classList.contains('ghead')`), 'Left from a folded row goes to its group');
    await key('Home');
    ok(await w(`document.activeElement.closest('.group').classList.contains('drift')`), 'Home is the first item');
    await key('End');
    ok(await w(`document.activeElement.classList.contains('res')`), 'End is the last row');
  });

  await step('the jump button opens the resource block in the .tf file', async () => {
    await w(`${W.row('local_file.config')}.querySelector('.jump').click()`);
    await waitFor(async () => (await vs.editorTabs()).some((t) => t.startsWith('main.tf')), { what: 'main.tf to open' });
    const lines = readFileSync(path.join(ws, 'infra', 'main.tf'), 'utf8').split('\n');
    const n = lines.findIndex((l) => l.startsWith('resource "local_file" "config"')) + 1;
    await waitFor(async () => (await statusBarSelection()).includes(`Ln ${n},`), { what: `cursor on line ${n}` });
    await vs.showTab('changes.json');
    ctx = await vs.webview('changes.json');
  });

  await step('a resource in a module jumps into the module folder', async () => {
    await w(`${W.row('module.child[1].random_integer.n')}.querySelector('.jump').click()`);
    await waitFor(async () => (await vs.editorTabs()).filter((t) => t.startsWith('main.tf')).length >= 1, { what: 'the module file' });
    await sleep(500);
    const tabs = await vs.editorTabs();
    ok(tabs.some((t) => t.startsWith('main.tf')), `tabs: ${tabs.join(' | ')}`);
    const uri = await vs.eval(`document.querySelector('.editor-group-container.active .monaco-editor')?.getAttribute('data-uri') ?? ''`);
    ok(uri.includes('modules/child/main.tf'), `opened ${uri}`);
    await vs.showTab('changes.json');
    ctx = await vs.webview('changes.json');
  });

  await step('Copy as Markdown puts a PR comment on the clipboard, sensitive values masked', async () => {
    await w(W.click('#copy'));
    await sleep(400);
    await newUntitled();
    try {
      await vs.key('v', { ctrl: true });
      await sleep(500);
      await vs.key('Home', { ctrl: true });
      await sleep(300);
      const md = await editorText();
      ok(md.startsWith('### Terraform plan: changes.json'), md.slice(0, 200));
      ok(md.includes('| Action | Count | Resource types |'), 'summary table');
      ok(md.includes('<details>'), 'details blocks');
    } finally {
      await vs.command('View: Revert and Close Editor');
    }
    await vs.showTab('changes.json');
    ctx = await vs.webview('changes.json');
    await w(W.click('#copySummary'));
    await sleep(400);
    await newUntitled();
    try {
      await vs.key('v', { ctrl: true });
      await sleep(400);
      await vs.key('Home', { ctrl: true });
      await sleep(300);
      const s = await editorText();
      ok(s.startsWith('changes.json: 3 to add, 1 to change, 4 to destroy, 3 to replace'), s.slice(0, 200));
    } finally {
      await vs.command('View: Revert and Close Editor');
    }
  });

  await step('sensitive values are masked and revealed one by one', async () => {
    await closeAll();
    await openInViewer('plans/sensitive.json');
    await w(`${W.row('random_password.db')}.querySelector('.line').click()`);
    await until(`${W.row('random_password.db')}.querySelector('.sens')`, 'a masked value');
    const detail = `${W.row('random_password.db')}.querySelector('.detail')`;
    ok(!(await w(`${detail}.textContent.includes('"') && /"[A-Za-z0-9]{16}"/.test(${detail}.textContent)`)), 'no secret shown');
    await w(`${detail}.querySelector('.eye[data-path="result"][data-on="true"]').click()`);
    await until(`/"[A-Za-z0-9]{16}"/.test(${detail}.textContent)`, 'the value revealed');
    ok(await w(`!!${detail}.querySelector('.eye[data-on="false"]')`), 'a hide button');
    await w(`${detail}.querySelector('.eye[data-on="false"]').click()`);
    await until(`!/"[A-Za-z0-9]{16}"/.test(${detail}.textContent)`, 'masked again');
    // Outputs too.
    ok(await w(`!!document.querySelector('#outputs .eye[data-output="password"]')`), 'a masked output');
    await w(W.click('#outputs .eye[data-output="password"]'));
    await until(`!document.querySelector('#outputs .eye[data-output="password"][data-on="true"]')`, 'the output revealed');
    // A text plan holds no value to reveal, but still says the value is sensitive.
    await closeAll();
    await openInViewer('plans/sensitive-plan.log');
    await w(`${W.row('random_password.db')}.querySelector('.line').click()`);
    await until(`${W.row('random_password.db')}.querySelector('.attrs .attr')`, 'attributes from the text');
    const result = await w(`[...${W.row('random_password.db')}.querySelectorAll('.attr')].find((a) => a.querySelector('.akey')?.textContent === 'result')?.querySelector('.aval').textContent`);
    ok((result.match(/\(sensitive\)/g) ?? []).length === 2, `both sides say sensitive: ${result}`);
    ok(await w(`document.querySelector('#outputs')?.textContent.includes('(sensitive)')`), 'the output says sensitive');
  });

  if (shotsFor) {
    await step('light theme screenshot', async () => {
      const userSettings = path.join(root, 'user-data', 'User', 'settings.json');
      writeFileSync(userSettings, JSON.stringify({ ...settings, 'workbench.colorTheme': 'Default Light Modern' }, null, 2));
      await sleep(2000);
      // Masked again before the picture: a README screenshot shows no secrets.
      await w(`document.querySelector('#outputs .eye[data-output="password"][data-on="false"]')?.click()`);
      await until(`!!document.querySelector('#outputs .eye[data-output="password"][data-on="true"]')`, 'the output masked again');
      await w(`${W.row('local_sensitive_file.secret')}.querySelector('.line').click()`);
      await until(`${W.row('local_sensitive_file.secret')}.querySelector('.attrs .attr')`, 'attributes');
      await w(`window.scrollTo(0, 0)`);
      await sleep(500);
      await shotOfEditor(path.join(shotsFor, 'sensitive-light.png'));
      writeFileSync(userSettings, JSON.stringify(settings, null, 2));
      await sleep(1500);
    });
  }

  await step('a CI log with colour codes opens from the Explorer menu and says what was stripped', async () => {
    await closeAll();
    await explorerMenu('ci-output.log', 'Open as Terraform Plan');
    ctx = await vs.webview('ci-output.log');
    await until(`${W.headline}.includes('to destroy')`, 'headline');
    ok(await w(`${W.cards}.includes('colour codes removed')`), 'note about colour codes');
    ok(await w(`document.getElementById('tool').textContent.includes('text output')`), 'source kind');
    eq((await w(W.chips)).replace, 3, 'replace count from text');
    ok(await w(`${W.cards}.includes('Check block assertion failed')`), 'warnings from the text');
  });

  await step('Reopen Editor With offers the viewer for a plan file', async () => {
    await closeAll();
    await openFile('plans/changes.json');
    await focusEditor();
    await paletteRun('View: Reopen Editor With...');
    await waitFor(async () => (await quickItems()).some((i) => i.includes('Terraform Plan Viewer')), { what: 'the viewer in the list' });
    await vs.pickQuickItem('Terraform Plan Viewer');
    ctx = await vs.webview('changes.json');
    await until(`${W.headline}.includes('4 to destroy')`, 'headline');
  });

  await step('Open Plan from Clipboard reads a GitHub Actions log', async () => {
    await closeAll();
    const log = readFileSync(path.join(fixtures, 'ci', 'github-actions.log'), 'utf8');
    // The first lines are enough: a header, a few resources, the plan line.
    const cut = log.split('\r\n').filter((l, i) => i < 70 || /Plan: |Changes to Outputs|replicas|rotated_at|to_remove/.test(l)).join('\n');
    await setClipboard(cut);
    await vs.command('Terraform Plan: Open Plan from Clipboard');
    ctx = await vs.webview('Clipboard');
    await until(`${W.headline}.length > 0`, 'headline');
    ok(await w(`${W.cards}.includes('GitHub Actions timestamps removed')`), 'note about timestamps');
    ok(await w(`${W.cards}.includes('colour codes removed')`), 'note about colour codes');
    ok((await vs.editorTabs()).some((t) => t.startsWith('Plan: Clipboard')), 'panel title');
  });

  await step('a binary .tfplan opens in the viewer by default, read with the configured binary', async () => {
    await closeAll();
    if (existsSync(calls)) writeFileSync(calls, '');
    await openFile('plans/changes.tfplan');
    ctx = await vs.webview('changes.tfplan');
    await until(`${W.headline}.includes('4 to destroy')`, 'headline from show -json', 20000);
    ok(await w(`${W.cards}.includes('Read with tofu show -json') && ${W.cards}.includes('OpenTofu 1.13.1')`), await w(W.cards));
    ok(await w(`document.getElementById('tool').textContent.includes('binary plan')`), 'source kind');
    const log = readFileSync(calls, 'utf8');
    ok(log.includes(`${path.join(ws, 'plans')} :: show -json -no-color changes.tfplan`), `calls: ${log}`);
    ok(!existsSync(evilMarker), 'the workspace setting for the binary was not used');
  });

  await step('Run Plan and Open runs the binary in the chosen folder and opens the result', async () => {
    await closeAll();
    await paletteRun('Terraform Plan: Run Plan and Open');
    // One folder with .tf files (the module folder is excluded): it runs right away.
    ctx = await vs.webview('infra', 25000);
    await until(`${W.headline}.includes('4 to destroy')`, 'headline from the run', 20000);
    ok(await w(`document.getElementById('tool').textContent.includes('plan run')`), 'source kind');
    const log = readFileSync(calls, 'utf8');
    ok(/infra :: plan -input=false -no-color -out=\S+plan\.tfplan$/m.test(log), `calls: ${log}`);
    ok(!existsSync(evilMarker), 'the workspace setting for the binary was not used');
  });

  await step('Compare Terraform Plans from the Explorer shows what changed between two runs', async () => {
    await closeAll();
    await explorerMenu('changes.json', 'Compare Terraform Plans', ['replace.json']);
    ctx = await vs.webview('changes.json → replace.json');
    await until(`${W.headline}.includes('differences')`, 'differences');
    const rows = await w(`[...document.querySelectorAll('.cmp')].map((r) => r.querySelector('.addr').textContent + ':' + r.querySelector('.st').textContent)`);
    ok(rows.includes('random_pet.server:different action'), `rows: ${rows.join(', ')}`);
    if (shotsFor) {
      await sleep(400);
      await shotOfEditor(path.join(shotsFor, 'compare-dark.png'));
    }
  });

  await step('files that are not plans: no title button, no commands', async () => {
    await closeAll();
    await openFile('plans/notes.json');
    await focusEditor();
    await sleep(800);
    ok(!(await vs.eval(`!!${titleButton}`)), 'no title button');
    await vs.key('F1');
    await waitFor(async () => (await vs.quickInputVisible()) && (await vs.quickInputValue()).startsWith('>'), { what: 'command palette' });
    await vs.type('Terraform Plan: Open as');
    await sleep(700);
    const items = await quickItems();
    await vs.key('Escape');
    ok(!items.some((i) => i.includes('Open as Terraform Plan')), `palette: ${items.join(' | ')}`);
  });

  await step('the viewer comes back after Reload Window, with its filters', async () => {
    await closeAll();
    await openInViewer('plans/changes.json');
    await w(W.click('.chip[data-action="create"]'));
    await w(`${W.row('local_file.config')}.querySelector('.line').click()`);
    await until(`${W.row('local_file.config')}.querySelector('.attrs .attr')`, 'attributes');
    // The Reload button: the open resource is asked for again, not left loading.
    await w(W.click('#reload'));
    await sleep(800);
    await until(`${W.row('local_file.config')}?.querySelector('.attrs .attr')`, 'attributes after Reload', 8000);
    await sleep(400);
    await focusWorkbench();
    vs.contexts.clear();
    await vs.command('Developer: Reload Window');
    await sleep(3000);
    await waitFor(() => vs.eval('!!document.querySelector(".monaco-workbench .part.statusbar")').catch(() => false), { timeout: 30000, what: 'workbench after reload' });
    await waitFor(async () => (await vs.editorTabs()).some((t) => t.startsWith('changes.json')), { timeout: 20000, what: 'restored tab' });
    await vs.showTab('changes.json');
    ctx = await vs.webview('changes.json', 25000);
    await until(`${W.headline}.includes('4 to destroy')`, 'restored plan', 15000);
    eq(await w(`document.querySelector('.chip[data-action="create"]').getAttribute('aria-pressed')`), 'false', 'filter kept');
    await until(`${W.row('local_file.config')}?.querySelector('.attrs .attr')`, 'the open resource filled in after Reload Window', 8000);
  });

  await step('a comparison and a plan run come back after Reload Window; the run runs again in its own tab', async () => {
    await closeAll();
    await paletteRun('Terraform Plan: Run Plan and Open');
    ctx = await vs.webview('infra', 25000);
    await until(`${W.headline}.includes('4 to destroy')`, 'run result', 20000);
    await explorerMenu('changes.json', 'Compare Terraform Plans', ['replace.json']);
    ctx = await vs.webview('changes.json → replace.json');
    await until(`${W.headline}.includes('differences')`, 'differences');
    await focusWorkbench();
    vs.contexts.clear();
    await vs.command('Developer: Reload Window');
    await sleep(3000);
    await waitFor(() => vs.eval('!!document.querySelector(".monaco-workbench .part.statusbar")').catch(() => false), { timeout: 30000, what: 'workbench after reload' });
    await waitFor(
      async () => {
        const tabs = await vs.editorTabs();
        return tabs.some((t) => t.startsWith('Plan:') && t.includes('infra')) && tabs.some((t) => t.startsWith('Compare plans'));
      },
      { timeout: 20000, what: 'restored tabs' },
    );
    await vs.showTab('Compare plans');
    ctx = await vs.webview('changes.json → replace.json', 25000);
    await until(`${W.headline}.includes('differences')`, 'compared again', 15000);
    await vs.showTab('Plan: workspace/infra');
    ctx = await vs.webview('workspace/infra', 25000);
    await until(`${W.cards}.includes('Run the Plan Again')`, 'run offered again', 15000);
    await w(W.click('button.act[data-act="run"]'));
    await until(`${W.headline}.includes('4 to destroy')`, 'ran again in place', 25000);
    eq((await vs.editorTabs()).filter((t) => t.startsWith('Plan:') && t.includes('infra')).length, 1, 'one tab for the run');
  });

  await step('no errors in the webviews', async () => {
    eq(vs.pageErrors, [], 'page errors');
  });

  await vs.close();
  await restricted();
} finally {
  await vs.close();
  console.log(`\n${passed} passed, ${failed.length} failed${failed.length ? `: ${failed.join('; ')}` : ''}`);
  console.log(`Profile and screenshots: ${root}`);
  process.exitCode = failed.length ? 1 : 0;
}

/** Restricted Mode: a copy of the workspace, never trusted, whose settings point at a binary. */
async function restricted() {
  const r = path.join(root, 'restricted');
  const ws2 = path.join(r, 'workspace');
  mkdirSync(path.join(ws2, 'plans'), { recursive: true });
  mkdirSync(path.join(ws2, 'infra'), { recursive: true });
  mkdirSync(path.join(ws2, '.vscode'), { recursive: true });
  copyFileSync(path.join(ws, 'plans', 'changes.json'), path.join(ws2, 'plans', 'changes.json'));
  copyFileSync(path.join(ws, 'plans', 'ci-output.log'), path.join(ws2, 'plans', 'ci-output.log'));
  copyFileSync(path.join(ws, 'plans', 'changes.tfplan'), path.join(ws2, 'plans', 'changes.tfplan'));
  copyFileSync(path.join(ws, 'infra', 'main.tf'), path.join(ws2, 'infra', 'main.tf'));
  writeFileSync(path.join(ws2, '.vscode', 'settings.json'), JSON.stringify({ 'terraformPlanViewer.binaryPath': path.join(bin, 'evil'), 'terraformPlanViewer.planArgs': ['-var=x=1'] }, null, 2));
  const trust = { ...settings, 'security.workspace.trust.enabled': true, 'security.workspace.trust.startupPrompt': 'never', 'security.workspace.trust.banner': 'never', 'security.workspace.trust.untrustedFiles': 'open' };
  delete trust['terraformPlanViewer.binaryPath'];
  vs = new VSCode(r);
  vs.install(vsix, trust);
  await vs.launch(ws2);
  await sleep(2500);

  await step('Restricted Mode: plan JSON and text plans open as usual', async () => {
    ok(await vs.eval(`!!document.querySelector('[id="status.workspaceTrust"], .statusbar-item[aria-label*="Restricted Mode"]') || document.body.textContent.includes('Restricted Mode')`), 'the window is in Restricted Mode');
    await openInViewer('plans/changes.json');
    await until(`${W.headline}.includes('4 to destroy')`, 'headline');
    await closeAll();
    await openInViewer('plans/ci-output.log');
    await until(`${W.headline}.includes('4 to destroy')`, 'headline from text');
  });

  await step('Restricted Mode: a binary plan is refused with a way to trust the folder, and nothing runs', async () => {
    await closeAll();
    await openFile('plans/changes.tfplan');
    ctx = await vs.webview('changes.tfplan');
    await until(`document.getElementById('cards').textContent.includes('needs a trusted workspace')`, 'the trust message');
    ok(await w(`!!document.querySelector('.card button[data-act="trust"]')`), 'a Manage Workspace Trust button');
    ok(!existsSync(evilMarker), 'the workspace binary did not run');
  });

  await step('Restricted Mode: Run Plan is not offered', async () => {
    await vs.key('F1');
    await waitFor(async () => (await vs.quickInputVisible()) && (await vs.quickInputValue()).startsWith('>'), { what: 'command palette' });
    await vs.type('Terraform Plan: Run Plan');
    await sleep(700);
    const items = await quickItems();
    await vs.key('Escape');
    ok(!items.some((i) => i.includes('Run Plan and Open')), `palette: ${items.join(' | ')}`);
  });

  await step('Restricted Mode: no errors in the webviews', async () => {
    eq(vs.pageErrors, [], 'page errors');
  });
}
