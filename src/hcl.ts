// Jumping from a resource address to its block in the workspace's .tf files, by text:
// `resource "type" "name"`, `data "type" "name"`, and `module "x"` blocks whose local
// `source` leads to the next module down.
import * as path from 'path';
import * as vscode from 'vscode';
import { modulePath, parseResourceAddress, splitAddress } from './core';

const MAX_FILES = 5000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const EXCLUDE = '{**/node_modules/**,**/.terraform/**,**/.git/**,**/vendor/**}';

export interface Found {
  uri: vscode.Uri;
  range: vscode.Range;
  /** The block matched: `resource "aws_instance" "web"` or `module "x"`. */
  label: string;
  /** Inside the module's own folder, as resolved from `source`. */
  inModule: boolean;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

interface TfFile {
  uri: vscode.Uri;
  text: string;
}

let cache: { at: number; files: TfFile[] } | undefined;

async function tfFiles(): Promise<TfFile[]> {
  if (cache && Date.now() - cache.at < 5000) return cache.files;
  const uris = await vscode.workspace.findFiles('**/*.{tf,tofu}', EXCLUDE, MAX_FILES);
  const files: TfFile[] = [];
  for (let i = 0; i < uris.length; i += 32) {
    const batch = uris.slice(i, i + 32);
    const texts = await Promise.all(
      batch.map(async (u) => {
        try {
          const st = await vscode.workspace.fs.stat(u);
          if (st.size > MAX_FILE_BYTES) return undefined;
          return new TextDecoder().decode(await vscode.workspace.fs.readFile(u));
        } catch {
          return undefined;
        }
      }),
    );
    batch.forEach((u, j) => texts[j] !== undefined && files.push({ uri: u, text: texts[j]! }));
  }
  cache = { at: Date.now(), files };
  return files;
}

function positions(text: string, re: RegExp): vscode.Range[] {
  const out: vscode.Range[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const before = text.slice(0, m.index + (m[1]?.length ?? 0));
    const line = before.split('\n').length - 1;
    const col = before.length - before.lastIndexOf('\n') - 1;
    out.push(new vscode.Range(line, col, line, col + m[0].length - (m[1]?.length ?? 0)));
  }
  return out;
}

/** The `source` of a `module "name"` block in a file, when it is a local path. */
function moduleSource(text: string, name: string): string | undefined {
  const re = new RegExp(`^[ \\t]*module\\s+"${escapeRe(name)}"\\s*\\{`, 'm');
  const m = re.exec(text);
  if (!m) return undefined;
  // Up to the block's closing brace (nesting counted roughly: enough for a source line).
  let depth = 0;
  let i = m.index + m[0].length - 1;
  const start = i;
  for (; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) break;
    }
  }
  const body = text.slice(start, i);
  const s = /^[ \t]*source\s*=\s*"([^"]+)"/m.exec(body);
  if (!s) return undefined;
  const src = s[1];
  return src.startsWith('./') || src.startsWith('../') ? src : undefined;
}

/** Where the block for an address is. Several when the workspace holds copies. */
export async function findBlocks(address: string): Promise<Found[]> {
  const files = await tfFiles();
  if (!files.length) return [];
  const { module, resource } = splitAddress(address);
  const modules = modulePath(module).map((m) => m.replace(/\[.*$/, ''));
  const parsed = parseResourceAddress(resource);
  // Resolve the module folder, step by step, from any file that declares the first module.
  let moduleDir: string | undefined;
  if (modules.length) {
    let candidates = files;
    for (const name of modules) {
      let next: string | undefined;
      for (const f of candidates) {
        const src = moduleSource(f.text, name);
        if (src) {
          next = path.resolve(path.dirname(f.uri.fsPath), src);
          break;
        }
      }
      if (!next) break;
      moduleDir = next;
      candidates = files.filter((f) => path.dirname(f.uri.fsPath) === next);
    }
  }
  const out: Found[] = [];
  if (!parsed.name) {
    // A module address on its own: its `module "x"` block.
    const last = modules[modules.length - 1];
    if (!last) return [];
    const re = new RegExp(`(^[ \\t]*)module\\s+"${escapeRe(last)}"\\s*\\{`, 'gm');
    for (const f of files) for (const r of positions(f.text, re)) out.push({ uri: f.uri, range: r, label: `module "${last}"`, inModule: false });
    return out;
  }
  const kind = parsed.mode === 'data' ? 'data' : 'resource';
  const re = new RegExp(`(^[ \\t]*)${kind}\\s+"${escapeRe(parsed.type)}"\\s+"${escapeRe(parsed.name)}"\\s*\\{`, 'gm');
  for (const f of files) {
    const inModule = moduleDir !== undefined && path.dirname(f.uri.fsPath) === moduleDir;
    for (const r of positions(f.text, re)) out.push({ uri: f.uri, range: r, label: `${kind} "${parsed.type}" "${parsed.name}"`, inModule });
  }
  // Inside the resolved module first; the root module's own files before others when no module.
  const root = (vscode.workspace.workspaceFolders ?? []).map((w) => w.uri.fsPath);
  out.sort((a, b) => Number(b.inModule) - Number(a.inModule) || (modules.length ? 0 : Number(root.includes(path.dirname(b.uri.fsPath))) - Number(root.includes(path.dirname(a.uri.fsPath)))) || a.uri.fsPath.localeCompare(b.uri.fsPath));
  return out;
}

/** Opens the block for an address, asking which when there are several. */
export async function jumpTo(address: string): Promise<boolean> {
  const found = await findBlocks(address);
  if (!found.length) {
    const { resource } = splitAddress(address);
    const p = parseResourceAddress(resource);
    const what = p.name ? `${p.mode === 'data' ? 'data' : 'resource'} "${p.type}" "${p.name}"` : address;
    vscode.window.showInformationMessage(`No \`${what}\` block was found in the workspace's .tf files.`);
    return false;
  }
  let pick = found[0];
  if (found.length > 1 && !(found[0].inModule && !found[1].inModule)) {
    const items = found.map((f) => ({ label: `$(file-code) ${vscode.workspace.asRelativePath(f.uri)}`, description: `line ${f.range.start.line + 1}${f.inModule ? ' · in the module' : ''}`, f }));
    const chosen = await vscode.window.showQuickPick(items, { title: `${found.length} blocks match ${address}`, placeHolder: 'Which one?' });
    if (!chosen) return false;
    pick = chosen.f;
  }
  const doc = await vscode.workspace.openTextDocument(pick.uri);
  await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, selection: pick.range, preview: true });
  return true;
}
