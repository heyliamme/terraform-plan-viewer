// Whether some text is a plan, and of which kind, from its start.

export type PlanKind = 'json' | 'text';

const TEXT_MARKS = [
  /\b(?:Terraform|OpenTofu) will perform the following actions:/,
  /\b(?:Terraform|OpenTofu) used the selected providers to generate the following execution plan/,
  /^[ \t]*Plan: \d+ to (?:add|import)/m,
  /^[ \t]*No changes\. (?:Your infrastructure (?:still )?matches the configuration|No objects need to be destroyed)/m,
  /^[ \t]*# [\w.\-\[\]"]+ (?:will be (?:created|destroyed|updated in-place|replaced|read during apply|imported)|must be replaced|has moved to|is tainted, so must be replaced|will be removed from the (?:Terraform|OpenTofu) state)/m,
  /^[ \t]*Changes to Outputs:/m,
  /Objects have changed outside of (?:Terraform|OpenTofu)/,
];

/** How much of a file is enough to tell plan JSON. */
export const DETECT_BYTES = 64 * 1024;
/**
 * How much of a text file is looked at: a CI log can hold a lot of setup output before the
 * plan starts.
 */
export const DETECT_TEXT_BYTES = 4 * 1024 * 1024;

/** Whether text holds a plan: its first DETECT_TEXT_BYTES, or all of it with `whole`. */
export function looksLikePlanText(text: string, whole = false): boolean {
  const head = !whole && text.length > DETECT_TEXT_BYTES ? text.slice(0, DETECT_TEXT_BYTES) : text;
  return TEXT_MARKS.some((re) => re.test(head));
}

/**
 * File bytes as text: UTF-16 with a byte order mark (what Windows PowerShell 5.1 writes for
 * `terraform show -json plan > plan.json`), else UTF-8.
 */
export function decodeText(bytes: Uint8Array): string {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);
  return new TextDecoder().decode(bytes);
}

/** A quick look at the first keys, without parsing the whole document. */
export function looksLikePlanJson(text: string): boolean {
  const head = text.length > DETECT_BYTES ? text.slice(0, DETECT_BYTES) : text;
  const t = head.trimStart();
  if (!t.startsWith('{')) return false;
  if (!/"format_version"\s*:\s*"/.test(head)) {
    // A large plan may put format_version last: look for the big keys instead.
    return /"resource_changes"\s*:\s*\[/.test(head) || /"planned_values"\s*:\s*\{/.test(head);
  }
  return /"resource_changes"\s*:|"resource_drift"\s*:|"planned_values"\s*:|"output_changes"\s*:|"prior_state"\s*:|"configuration"\s*:/.test(head) || head.length < DETECT_BYTES;
}

export function detectPlan(text: string, whole = false): PlanKind | undefined {
  if (looksLikePlanJson(text)) return 'json';
  if (looksLikePlanText(text, whole)) return 'text';
  return undefined;
}

const ZIP = [0x50, 0x4b, 0x03, 0x04];

/** A binary plan is a zip archive. */
export function looksLikeBinaryPlan(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && ZIP.every((b, i) => bytes[i] === b);
}
