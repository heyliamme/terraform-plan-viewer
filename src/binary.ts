// Running `terraform` / `tofu`: reading a binary plan with `show -json`, and `plan -out`.
// Always execFile with an argument list, in the plan's folder, with a timeout, and never in
// Restricted Mode.
import { execFile, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

export const SECTION = 'terraformPlanViewer';

export type Flavor = 'terraform' | 'opentofu' | 'unknown';

export class BinaryError extends Error {
  constructor(
    message: string,
    public readonly why: 'restricted' | 'outside' | 'notFound' | 'failed' | 'cancelled' | 'timeout',
    public readonly detail?: string,
    /** For `outside`: the folder the binary would run in. */
    public readonly folder?: string,
  ) {
    super(message);
  }
}

const FORBIDDEN_ARGS = ['-out', '-chdir', '-state', '-state-out', '-backup', '-generate-config-out', '-json', '-input'];
/** Options of `plan` that take a value, which may come as the next argument: `-var-file prod.tfvars`. */
const VALUE_ARGS = ['-var', '-var-file', '-target', '-replace', '-exclude', '-lock-timeout', '-parallelism'];

/** The extra arguments for `plan`, from settings, with the ones that would redirect its output refused. */
export function validatePlanArgs(args: unknown): string[] {
  if (!Array.isArray(args)) return [];
  const out: string[] = [];
  let wantsValue = false;
  for (const a of args) {
    if (typeof a !== 'string' || !a.trim()) continue;
    const s = a.trim();
    if (/[\r\n\0]/.test(s)) throw new BinaryError('terraformPlanViewer.planArgs: an argument holds a control character.', 'failed');
    if (!s.startsWith('-')) {
      // The value of the option before it, as in `-var-file prod.tfvars`.
      if (!wantsValue) throw new BinaryError(`terraformPlanViewer.planArgs: "${s}" is not an option (options start with -) and doesn't follow one that takes a value.`, 'failed');
      wantsValue = false;
      out.push(s);
      continue;
    }
    const name = s.replace(/^--?/, '-').split('=')[0];
    if (FORBIDDEN_ARGS.includes(name)) throw new BinaryError(`terraformPlanViewer.planArgs: ${name} is not allowed here.`, 'failed');
    wantsValue = !s.includes('=') && VALUE_ARGS.includes(name);
    out.push(s);
  }
  return out;
}

async function isExecutable(file: string): Promise<boolean> {
  try {
    const st = await fs.promises.stat(file);
    if (!st.isFile()) return false;
    if (process.platform !== 'win32') await fs.promises.access(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Windows wrappers that Node can't start without a shell (since the CVE-2024-27980 fix). */
const SHIM = /\.(?:cmd|bat)$/i;

/** Where a command is on PATH, like `which`. On Windows a .cmd/.bat wrapper is skipped, and returned as `shim`. */
export async function onPath(name: string): Promise<string | undefined> {
  return (await lookPath(name)).found;
}

async function lookPath(name: string): Promise<{ found?: string; shim?: string }> {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const exts = process.platform === 'win32' ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').filter(Boolean) : [''];
  let shim: string | undefined;
  for (const d of dirs)
    for (const ext of exts) {
      for (const f of new Set([path.join(d, name + ext.toLowerCase()), path.join(d, name + ext)])) {
        if (!(await isExecutable(f))) continue;
        if (SHIM.test(f)) shim ??= f;
        else return { found: f };
      }
    }
  return { shim };
}

const shimError = (file: string) => new BinaryError(`${file} is a .cmd/.bat wrapper, which can't be started without a shell. Set terraformPlanViewer.binaryPath to the terraform or tofu .exe it runs.`, 'notFound');

export interface Binary {
  cmd: string;
  /** What it is, for messages: "tofu", "terraform", or the configured path. */
  name: string;
}

/**
 * Throws unless a binary plan may be read here: before anything looks inside the file, so an
 * untrusted one costs nothing to open.
 */
export function requireBinaryAllowed(file: string) {
  requireTrust('Opening a binary plan');
  requireKnownFolder(file);
}

function requireTrust(what: string) {
  if (!vscode.workspace.isTrusted) throw new BinaryError(`${what} needs a trusted workspace: no Terraform or OpenTofu binary runs in Restricted Mode. Plan JSON and text plans still open.`, 'restricted');
}

/**
 * The binary to use: the configured one, else the tool that wrote the plan if it is on
 * PATH, else the other one.
 */
export async function findBinary(prefer: Flavor): Promise<Binary> {
  const setting = vscode.workspace.getConfiguration(SECTION).get<unknown>('binaryPath');
  const configured = typeof setting === 'string' ? setting.trim() : '';
  if (configured) {
    if (configured.includes('/') || configured.includes('\\')) {
      if (process.platform === 'win32' && SHIM.test(configured)) throw shimError(configured);
      if (await isExecutable(configured)) return { cmd: configured, name: configured };
      throw new BinaryError(`terraformPlanViewer.binaryPath points at ${configured}, which is not an executable file.`, 'notFound');
    }
    const look = await lookPath(configured);
    if (look.found) return { cmd: look.found, name: configured };
    if (look.shim) throw shimError(look.shim);
    throw new BinaryError(`terraformPlanViewer.binaryPath names "${configured}", which is not on your PATH.`, 'notFound');
  }
  const order = prefer === 'opentofu' ? ['tofu', 'terraform'] : ['terraform', 'tofu'];
  let shim: string | undefined;
  for (const name of order) {
    const look = await lookPath(name);
    if (look.found) return { cmd: look.found, name };
    shim ??= look.shim;
  }
  if (shim) throw shimError(shim);
  throw new BinaryError(`Neither terraform nor tofu is on your PATH. Install one, or set terraformPlanViewer.binaryPath.`, 'notFound');
}

const MAX_BUFFER = 1024 * 1024 * 1024;

function env(): NodeJS.ProcessEnv {
  return { ...process.env, TF_IN_AUTOMATION: '1', TF_INPUT: '0', NO_COLOR: '1' };
}

function describeFailure(cmd: string, args: string[], e: NodeJS.ErrnoException & { stderr?: string; killed?: boolean; signal?: string; code?: number | string }): BinaryError {
  const stderr = typeof e.stderr === 'string' ? e.stderr.trim() : '';
  const detail = stderr.length > 4000 ? stderr.slice(0, 4000) + '…' : stderr;
  if (e.code === 'ENOENT') return new BinaryError(`${cmd} could not be started (not found).`, 'notFound', detail);
  if (e.code === 'EINVAL') return new BinaryError(`${cmd} could not be started (EINVAL): on Windows that is a .cmd/.bat wrapper. Set terraformPlanViewer.binaryPath to the .exe.`, 'notFound', detail);
  if (e.killed || e.signal === 'SIGTERM' || e.signal === 'SIGKILL') return new BinaryError(`${path.basename(cmd)} ${args[0]} was stopped${e.signal ? ` (${e.signal})` : ''}.`, 'timeout', detail);
  const first = detail.split('\n').find((l) => /Error:/.test(l)) ?? detail.split('\n')[0] ?? '';
  return new BinaryError(`${path.basename(cmd)} ${args[0]} failed${first ? `: ${first.replace(/^.*Error:\s*/, '')}` : ` (exit ${e.code})`}.`, 'failed', detail);
}

/**
 * How long a stopped terraform gets to finish on its own before it is killed. On an
 * interrupt it ends the provider call in flight and lets go of the state lock; killed, it
 * leaves the lock held.
 */
const GRACE_MS = 60_000;

/** A timeout setting in milliseconds: whole seconds, at least `min`, at most a day. */
export function timeoutSetting(seconds: unknown, min: number, fallback: number): number {
  const s = typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= min ? seconds : fallback;
  return Math.round(Math.min(s, 86_400)) * 1000;
}

function run(cmd: string, args: string[], cwd: string, timeoutMs: number, token?: vscode.CancellationToken, onLine?: (line: string) => void): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    let stopped: 'cancelled' | 'timeout' | undefined;
    let timer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    // An interrupt first, as Ctrl+C would send (on Windows there is no such signal: the
    // process ends at once), then a kill once the grace is over.
    const stop = (why: 'cancelled' | 'timeout') => {
      if (stopped) return;
      stopped = why;
      child.kill('SIGINT');
      killTimer = setTimeout(() => child.kill('SIGKILL'), GRACE_MS);
      killTimer.unref();
    };
    try {
      child = execFile(cmd, args, { cwd, maxBuffer: MAX_BUFFER, env: env(), windowsHide: true, encoding: 'utf8' }, (e, stdout, stderr) => {
        sub?.dispose();
        if (timer) clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        if (e || stopped) {
          if (stopped === 'cancelled' || token?.isCancellationRequested) return reject(new BinaryError(`${path.basename(cmd)} ${args[0]} was cancelled.`, 'cancelled'));
          if (stopped === 'timeout') return reject(new BinaryError(`${path.basename(cmd)} ${args[0]} was stopped after ${Math.round(timeoutMs / 1000)} s (the time limit).`, 'timeout', typeof stderr === 'string' ? stderr.trim().slice(0, 4000) : undefined));
          return reject(describeFailure(cmd, args, e as never));
        }
        resolve({ stdout: String(stdout), stderr: String(stderr) });
      });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EINVAL') return reject(describeFailure(cmd, args, e as never));
      return reject(new BinaryError(`${cmd} could not be started: ${e instanceof Error ? e.message : String(e)}`, 'failed'));
    }
    timer = setTimeout(() => stop('timeout'), timeoutMs);
    const sub = token?.onCancellationRequested(() => stop('cancelled'));
    if (onLine && child.stdout) {
      let buf = '';
      child.stdout.on('data', (d: string) => {
        buf += d;
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const l of lines) if (l.trim()) onLine(l.trim());
      });
    }
  });
}

/** Folders outside the workspace the person said `show` may run in, this session. */
const allowedFolders = new Set<string>();

/** Lets `show` run in a folder outside the workspace, after the person said so. */
export function allowFolder(folder: string) {
  allowedFolders.add(path.resolve(folder));
}

/**
 * `show` starts the provider plugins it finds in the plan's folder (`.terraform/providers`).
 * Workspace Trust vouches for the workspace's folders only, and an empty window is trusted
 * by default: a plan anywhere else (a downloaded CI artifact with its own `.terraform`) is
 * read only once the person has said so for that folder.
 */
function requireKnownFolder(file: string) {
  const dir = path.dirname(path.resolve(file));
  if (vscode.workspace.getWorkspaceFolder(vscode.Uri.file(file)) || allowedFolders.has(dir)) return;
  throw new BinaryError(`This plan is outside the workspace. Reading it runs ${'`show -json`'} in ${dir}, which starts the provider plugins found there. Only go on if you trust that folder.`, 'outside', undefined, dir);
}

/** The JSON of a binary plan, from `show -json` run in the plan's folder. */
export async function showJson(file: string, prefer: Flavor, token?: vscode.CancellationToken): Promise<{ json: string; binary: Binary }> {
  requireTrust('Opening a binary plan');
  requireKnownFolder(file);
  const binary = await findBinary(prefer);
  const timeout = timeoutSetting(vscode.workspace.getConfiguration(SECTION).get<unknown>('showTimeoutSeconds'), 5, 60);
  const dir = path.dirname(file);
  let base = path.basename(file);
  if (base.startsWith('-')) base = `.${path.sep}${base}`;
  const { stdout } = await run(binary.cmd, ['show', '-json', '-no-color', base], dir, timeout, token);
  return { json: stdout, binary };
}

export interface RunPlanResult {
  json: string;
  binary: Binary;
  /** The last lines terraform printed, for the notes. */
  log: string[];
}

/** `plan -out` into a temporary file, then `show -json` on it; the file is removed afterwards. */
export async function runPlan(dir: string, prefer: Flavor, token: vscode.CancellationToken, progress: (message: string) => void): Promise<RunPlanResult> {
  requireTrust('Run Plan');
  const binary = await findBinary(prefer);
  const args = validatePlanArgs(vscode.workspace.getConfiguration(SECTION).get<unknown>('planArgs'));
  const timeout = timeoutSetting(vscode.workspace.getConfiguration(SECTION).get<unknown>('planTimeoutSeconds'), 10, 900);
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'terraform-plan-viewer-'));
  const out = path.join(tmp, 'plan.tfplan');
  const log: string[] = [];
  try {
    // On Windows a stopped plan can't be interrupted, only ended, which would leave the state
    // lock held: plan without taking it there (the plan is only read, never applied).
    const lock = process.platform === 'win32' ? ['-lock=false'] : [];
    await run(binary.cmd, ['plan', '-input=false', '-no-color', ...lock, `-out=${out}`, ...args], dir, timeout, token, (line) => {
      log.push(line);
      if (log.length > 50) log.shift();
      progress(line.length > 80 ? line.slice(0, 79) + '…' : line);
    });
    progress('Reading the plan…');
    // In the configuration's folder: reading a plan loads the provider schemas from its
    // `.terraform`, which the temporary folder doesn't have.
    const { stdout } = await run(binary.cmd, ['show', '-json', '-no-color', out], dir, timeout, token);
    return { json: stdout, binary, log };
  } finally {
    await fs.promises.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
}
