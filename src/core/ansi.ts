// Cleans a CI log before the text plan is read: colour codes, timestamps and the markers
// that GitHub Actions, GitLab, Azure Pipelines, Jenkins, Atlantis and Markdown wrap lines in.

export interface Cleaned {
  text: string;
  /** What was removed, in words for the reader: "colour codes", "GitHub Actions timestamps". */
  notes: string[];
}

// eslint-disable-next-line no-control-regex
const CSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
// eslint-disable-next-line no-control-regex
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
// eslint-disable-next-line no-control-regex
const OTHER_ESC = /\x1b[@-Z\\-_]/g;
/**
 * Colour codes whose ESC byte was lost on the way (`[0m`, `[1m`, `[32m`). Not one followed
 * by `]`: `[5m]` is a duration in a PromQL expression.
 */
const BARE_SGR = /\[(?:\d{1,3}(?:;\d{1,3})*)?m(?!\])/g;
/** A reset, which every colour run ends with: lost escapes have plenty of them. */
const BARE_RESET = /\[0?m(?!\])/g;
/** A double-quoted string on a line: values, never colour codes. */
const QUOTED = /"(?:[^"\\\n]|\\.)*"/g;

/** A line without its bare colour codes, leaving quoted strings as they are. */
function stripBare(line: string): string {
  if (!line.includes('[')) return line;
  let out = '';
  let last = 0;
  for (const m of line.matchAll(QUOTED)) {
    out += line.slice(last, m.index).replace(BARE_SGR, '') + m[0];
    last = m.index! + m[0].length;
  }
  return out + line.slice(last).replace(BARE_SGR, '');
}

/** One bare colour code, at the start of what is left of a line. */
const LEAD_SGR = /^\[(?:\d{1,3}(?:;\d{1,3})*)?m/;
/** Bare colour codes ending a line. */
const TRAIL_SGR = /(?:\[(?:\d{1,3}(?:;\d{1,3})*)?m)+$/;
/** A line that opens a heredoc, once its colour codes are gone: `user_data = <<-EOT`. */
const HEREDOC_OPEN = /<<-?([A-Za-z_][A-Za-z0-9_]*)\s*$/;

/**
 * A heredoc body line without the colour codes Terraform puts around its indentation and
 * `+` / `-` symbol. The text of the line is a value: nothing inside it is removed.
 */
function stripHeredocLine(line: string): string {
  let out = '';
  let i = 0;
  let coloured = false;
  for (;;) {
    const ws = /^\s+/.exec(line.slice(i));
    if (ws) {
      out += ws[0];
      i += ws[0].length;
      continue;
    }
    const sgr = LEAD_SGR.exec(line.slice(i));
    if (sgr) {
      i += sgr[0].length;
      coloured = true;
      continue;
    }
    // The symbol only counts when a colour code came just before it.
    if (coloured && /^[-+~]/.test(line.slice(i)) && LEAD_SGR.test(line.slice(i + 1))) {
      out += line[i];
      i++;
      continue;
    }
    break;
  }
  const rest = line.slice(i);
  return out + (coloured ? rest.replace(TRAIL_SGR, '') : rest);
}

/**
 * Lines without their bare colour codes. Quoted strings are left as they are, and so are
 * heredoc bodies, where only the codes around the indentation and the symbol go.
 */
function stripBareLines(lines: string[]): string[] {
  const out: string[] = [];
  let marker: string | undefined;
  for (const line of lines) {
    if (marker !== undefined) {
      const lead = stripHeredocLine(line);
      const t = lead.trimStart();
      if (t.startsWith(marker) && /^\s*(?:$|,|->|#)/.test(stripBare(t.slice(marker.length)))) {
        marker = undefined;
        out.push(stripBare(line));
      } else out.push(lead);
      continue;
    }
    const s = stripBare(line);
    const open = HEREDOC_OPEN.exec(s);
    if (open) marker = open[1];
    out.push(s);
  }
  return out;
}

const GITHUB_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z ?/;
const BRACKET_TS = /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\] ?/;
const AZURE = /^##\[(?:section|group|endgroup|debug|command|warning|error)\]/;
const GITLAB_SECTION = /section_(?:start|end):\d+:[\w-]+(?:\[[^\]]*\])?/g;

export function cleanLog(input: string): Cleaned {
  const notes: string[] = [];
  let text = input;
  // eslint-disable-next-line no-control-regex
  if (/\x1b/.test(text)) {
    text = text.replace(OSC, '').replace(CSI, '').replace(OTHER_ESC, '');
    notes.push('colour codes removed');
  } else {
    // Only when it really looks like lost escapes: resets on several lines.
    const resets = text.match(BARE_RESET);
    if (resets && resets.length >= 3) {
      text = stripBareLines(text.split('\n')).join('\n');
      notes.push('colour codes (without their escape byte) removed');
    }
  }
  if (text.includes('\r')) text = text.replace(/\r\n?/g, '\n');
  if (GITLAB_SECTION.test(text)) {
    text = text.replace(GITLAB_SECTION, '');
    notes.push('GitLab section markers removed');
  }
  GITLAB_SECTION.lastIndex = 0;
  const lines = text.split('\n');
  let github = 0;
  let bracket = 0;
  let azure = 0;
  let markdown = 0;
  const out: string[] = [];
  for (let line of lines) {
    if (GITHUB_TS.test(line)) {
      line = line.replace(GITHUB_TS, '');
      github++;
    } else if (BRACKET_TS.test(line)) {
      line = line.replace(BRACKET_TS, '');
      bracket++;
    }
    if (AZURE.test(line)) {
      azure++;
      continue;
    }
    // Markdown wrapping (a PR comment) starts at the margin. Plan lines are indented, so a
    // heredoc holding a README or HTML keeps its fences and tags.
    const margin = !/^\s/.test(line);
    if (margin && line.startsWith('```')) {
      markdown++;
      continue;
    }
    if (margin && /^<\/?(?:details|summary)\b/i.test(line)) {
      const stripped = line.replace(/<summary\b[^>]*>.*?<\/summary>/gi, '').replace(/<\/?(?:details|summary)\b[^>]*>/gi, '');
      markdown++;
      if (!stripped.trim()) continue;
      line = stripped;
    }
    // trimEnd, not a regex: `\s+$` backtracks on a long run of spaces before a character.
    out.push(line.trimEnd());
  }
  if (github) notes.push('GitHub Actions timestamps removed');
  if (bracket) notes.push('timestamps removed');
  if (azure) notes.push('Azure Pipelines markers removed');
  if (markdown) notes.push('Markdown fences and details tags removed');
  return { text: out.join('\n'), notes };
}
