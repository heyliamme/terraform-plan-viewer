// The extension manifest and what the package ships.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const settings = pkg.contributes.configuration.properties;

test('the binary path and plan arguments can only come from user or machine settings', () => {
  const restricted = pkg.capabilities.untrustedWorkspaces.restrictedConfigurations;
  assert.ok(restricted.includes('terraformPlanViewer.binaryPath'));
  assert.ok(restricted.includes('terraformPlanViewer.planArgs'));
  assert.equal(settings['terraformPlanViewer.binaryPath'].scope, 'machine');
  assert.equal(settings['terraformPlanViewer.planArgs'].scope, 'machine');
  assert.equal(pkg.capabilities.untrustedWorkspaces.supported, 'limited');
});

test('a .tfplan opens in the viewer by default; JSON and text through Reopen With', () => {
  const editors = pkg.contributes.customEditors;
  const binary = editors.find((e) => e.viewType === 'terraformPlanViewer.binary');
  assert.equal(binary.priority, 'default');
  assert.deepEqual(binary.selector, [{ filenamePattern: '*.tfplan' }, { filenamePattern: 'tfplan' }]);
  // `terraform plan -out=tfplan`, the name HashiCorp's CI guides use, has no extension.
  const explorer = pkg.contributes.menus['explorer/context'];
  for (const c of ['terraformPlanViewer.open', 'terraformPlanViewer.compareSelected']) assert.match(explorer.find((m) => m.command === c).when, /resourceFilename == tfplan/);
  const option = editors.find((e) => e.viewType === 'terraformPlanViewer.plan');
  assert.equal(option.priority, 'option');
  assert.ok(option.selector.some((s) => s.filenamePattern === '*.json'));
  assert.ok(option.selector.some((s) => s.filenamePattern === '*.txt'));
});

test('commands that need a plan only show for one; Run Plan only in a trusted workspace', () => {
  const palette = Object.fromEntries(pkg.contributes.menus.commandPalette.map((m) => [m.command, m.when]));
  assert.match(palette['terraformPlanViewer.open'], /terraformPlanViewer\.isPlan/);
  assert.match(palette['terraformPlanViewer.compare'], /terraformPlanViewer\.isPlan/);
  assert.match(palette['terraformPlanViewer.runPlan'], /isWorkspaceTrusted/);
  assert.equal(palette['terraformPlanViewer.compareSelected'], 'false');
  for (const m of pkg.contributes.menus['explorer/context'].filter((x) => x.command === 'terraformPlanViewer.runPlan')) assert.match(m.when, /isWorkspaceTrusted/);
});

test('the package ships the third-party notices for what it bundles', () => {
  assert.match(readFileSync(new URL('../.vscodeignore', import.meta.url), 'utf8'), /^!ThirdPartyNotices\.txt$/m);
  const notices = readFileSync(new URL('../ThirdPartyNotices.txt', import.meta.url), 'utf8');
  const version = (name) => JSON.parse(readFileSync(new URL(`../node_modules/${name}/package.json`, import.meta.url), 'utf8')).version;
  assert.ok(notices.includes(`@vscode/codicons ${version('@vscode/codicons')}`), 'codicons version');
  assert.match(notices, /creativecommons\.org\/licenses\/by\/4\.0/);
  assert.deepEqual(Object.keys(pkg.dependencies ?? {}), [], 'no runtime dependencies');
});

test('the README documents every setting and command', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  for (const key of Object.keys(settings)) assert.ok(readme.includes(`\`${key}\``), key);
  for (const c of pkg.contributes.commands) if (!/compareSelected/.test(c.command)) assert.ok(readme.includes(c.title.replace(/…$/, '')), c.title);
});
