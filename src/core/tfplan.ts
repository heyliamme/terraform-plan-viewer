// A look inside a binary plan file (a zip holding a protobuf `tfplan` and the state), to
// tell which tool and version wrote it, without running anything.
import { inflateRawSync } from 'node:zlib';

export interface BinaryPlanInfo {
  flavor: 'terraform' | 'opentofu' | 'unknown';
  version?: string;
  /** The archive's entries, for the reader (and to confirm it is a plan at all). */
  entries: string[];
}

interface Entry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  offset: number;
}

/** The most any one entry is inflated to; enough for the version and provider sniffing. */
const MAX_INFLATE = 64 * 1024 * 1024;
/** The most inflated for the whole archive. */
const MAX_INFLATE_TOTAL = 96 * 1024 * 1024;

function readEntries(buf: Buffer): Entry[] {
  // End of central directory: the last 22 bytes, before an optional comment of up to 64 KB.
  const min = Math.max(0, buf.length - 22 - 65535);
  let eocd = -1;
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return [];
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries: Entry[] = [];
  for (let i = 0; i < count && p + 46 <= buf.length; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const offset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    entries.push({ name, method, compressedSize, size, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function readEntry(buf: Buffer, e: Entry, max = MAX_INFLATE): Buffer | undefined {
  if (e.offset + 30 > buf.length || buf.readUInt32LE(e.offset) !== 0x04034b50) return undefined;
  const nameLen = buf.readUInt16LE(e.offset + 26);
  const extraLen = buf.readUInt16LE(e.offset + 28);
  const start = e.offset + 30 + nameLen + extraLen;
  if (e.compressedSize > buf.length - start || e.size > max) return undefined;
  const data = buf.subarray(start, start + e.compressedSize);
  try {
    if (e.method === 0) return data;
    // The declared size is the archive's word for it: cap what inflating may produce, so a
    // small entry can't expand to gigabytes (it throws past the cap, and is skipped).
    if (e.method === 8) return inflateRawSync(data, { maxOutputLength: max });
  } catch {
    return undefined;
  }
  return undefined;
}

/** Top-level string fields of a protobuf message, by field number. */
function protoStrings(buf: Buffer): Map<number, string[]> {
  const out = new Map<number, string[]>();
  let p = 0;
  const varint = (): number | undefined => {
    let shift = 0;
    let v = 0;
    while (p < buf.length) {
      const b = buf[p++];
      v += (b & 0x7f) * 2 ** shift;
      if (!(b & 0x80)) return v;
      shift += 7;
      if (shift > 63) return undefined;
    }
    return undefined;
  };
  while (p < buf.length) {
    const tag = varint();
    if (tag === undefined) break;
    const field = Math.floor(tag / 8);
    const wire = tag & 7;
    if (wire === 0) {
      if (varint() === undefined) break;
    } else if (wire === 1) p += 8;
    else if (wire === 5) p += 4;
    else if (wire === 2) {
      const len = varint();
      if (len === undefined || p + len > buf.length) break;
      const s = buf.subarray(p, p + len);
      p += len;
      if (len < 256) {
        const text = s.toString('utf8');
        if (/^[\x20-\x7e]*$/.test(text)) out.set(field, [...(out.get(field) ?? []), text]);
      }
    } else break;
  }
  return out;
}

/** Which tool wrote a binary plan, and its version, from the archive's contents. */
export function inspectBinaryPlan(bytes: Uint8Array): BinaryPlanInfo {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entries = readEntries(buf);
  const info: BinaryPlanInfo = { flavor: 'unknown', entries: entries.map((e) => e.name) };
  let tofu = false;
  let terraform = false;
  // Each wanted entry once, the first of its name: a crafted archive can list one big entry
  // thousands of times over, and every copy would be inflated again.
  const seen = new Set<string>();
  let budget = MAX_INFLATE_TOTAL;
  for (const e of entries) {
    if (e.name !== 'tfplan' && e.name !== 'tfstate' && e.name !== '.terraform.lock.hcl') continue;
    if (seen.has(e.name)) continue;
    seen.add(e.name);
    if (budget <= 0) break;
    const data = readEntry(buf, e, Math.min(MAX_INFLATE, budget));
    if (!data) continue;
    budget -= data.length;
    const text = data.toString('latin1');
    if (text.includes('registry.opentofu.org')) tofu = true;
    if (text.includes('registry.terraform.io')) terraform = true;
    if (e.name === 'tfplan') {
      const fields = protoStrings(data);
      // Plan.terraform_version is field 14; fall back to the first version-shaped string.
      const v = fields.get(14)?.find((s) => /^\d+\.\d+\.\d+/.test(s)) ?? [...fields.values()].flat().find((s) => /^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(s));
      if (v) info.version = v;
    } else if (e.name === 'tfstate' && !info.version) {
      const m = /"terraform_version"\s*:\s*"([^"]+)"/.exec(text);
      if (m) info.version = m[1];
    }
  }
  info.flavor = tofu ? 'opentofu' : terraform ? 'terraform' : 'unknown';
  return info;
}
