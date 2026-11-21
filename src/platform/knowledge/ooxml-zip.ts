import { inflateBounded } from "./pdf-format";

/**
 * Minimal ZIP reader for OOXML packages (DOCX/XLSX). Supports stored (0) and deflate (8) entries
 * only. Never evaluates macros or follows external links — entries are bytes, nothing more
 * (AGENTS.md §4.8). Used by T-212 extractors; capture already metered the whole object size.
 */

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

function u16(bytes: Uint8Array, at: number): number {
  return bytes[at]! | (bytes[at + 1]! << 8);
}
function u32(bytes: Uint8Array, at: number): number {
  return (
    (bytes[at]! | (bytes[at + 1]! << 8) | (bytes[at + 2]! << 16) | (bytes[at + 3]! << 24)) >>> 0
  );
}

function findEocd(bytes: Uint8Array): number {
  // EOCD is at the end; comment length ≤ 65535, so scan back that far.
  const min = Math.max(0, bytes.length - 65557);
  for (let i = bytes.length - 22; i >= min; i--) {
    if (u32(bytes, i) === EOCD_SIG) return i;
  }
  return -1;
}

/**
 * List and inflate every central-directory entry. Caps total decompressed volume with `budgetBytes`
 * so a ZIP bomb cannot explode past the capture meter.
 */
export async function readZipEntries(
  bytes: Uint8Array,
  budgetBytes: number,
): Promise<{ ok: true; entries: ZipEntry[] } | { ok: false; reason: "malformed" | "bomb" }> {
  const eocd = findEocd(bytes);
  if (eocd < 0) return { ok: false, reason: "malformed" };
  const entryCount = u16(bytes, eocd + 10);
  let cenOffset = u32(bytes, eocd + 16);
  let budget = budgetBytes;
  const entries: ZipEntry[] = [];

  for (let i = 0; i < entryCount; i++) {
    if (cenOffset + 46 > bytes.length || u32(bytes, cenOffset) !== CEN_SIG) {
      return { ok: false, reason: "malformed" };
    }
    const method = u16(bytes, cenOffset + 10);
    const compSize = u32(bytes, cenOffset + 20);
    const uncompSize = u32(bytes, cenOffset + 24);
    const nameLen = u16(bytes, cenOffset + 28);
    const extraLen = u16(bytes, cenOffset + 30);
    const commentLen = u16(bytes, cenOffset + 32);
    const localHeaderOffset = u32(bytes, cenOffset + 42);
    const nameStart = cenOffset + 46;
    const nameEnd = nameStart + nameLen;
    if (nameEnd > bytes.length) return { ok: false, reason: "malformed" };
    const name = new TextDecoder("utf-8").decode(bytes.subarray(nameStart, nameEnd));
    cenOffset = nameEnd + extraLen + commentLen;

    if (localHeaderOffset + 30 > bytes.length || u32(bytes, localHeaderOffset) !== LOC_SIG) {
      return { ok: false, reason: "malformed" };
    }
    const locNameLen = u16(bytes, localHeaderOffset + 26);
    const locExtraLen = u16(bytes, localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + locNameLen + locExtraLen;
    const dataEnd = dataStart + compSize;
    if (dataEnd > bytes.length) return { ok: false, reason: "malformed" };
    const compressed = bytes.subarray(dataStart, dataEnd);

    let data: Uint8Array;
    if (method === 0) {
      if (uncompSize > budget) return { ok: false, reason: "bomb" };
      data = compressed.slice();
      budget -= data.byteLength;
    } else if (method === 8) {
      const inflated = await inflateBounded(compressed, Math.min(budget, Math.max(uncompSize, 1)));
      if (!inflated.ok) return { ok: false, reason: inflated.reason === "budget" ? "bomb" : "malformed" };
      data = inflated.data;
      budget -= data.byteLength;
    } else {
      // Unsupported method (e.g. encrypted) — skip the entry; extractors treat missing parts as failure.
      continue;
    }
    if (budget < 0) return { ok: false, reason: "bomb" };
    entries.push({ name, data });
  }
  return { ok: true, entries };
}

export function entryText(entries: readonly ZipEntry[], name: string): string | null {
  const found = entries.find((e) => e.name === name);
  if (!found) return null;
  return new TextDecoder("utf-8").decode(found.data);
}

/** Build a tiny stored-method ZIP for synthetic fixtures (tests only). */
export function buildStoredZip(files: ReadonlyArray<{ name: string; body: string }>): Uint8Array {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const file of files) {
    const nameBytes = encoder.encode(file.name);
    const data = encoder.encode(file.body);
    const local = new Uint8Array(30 + nameBytes.length + data.length);
    const view = new DataView(local.buffer);
    view.setUint32(0, LOC_SIG, true);
    view.setUint16(8, 0, true); // method stored
    view.setUint32(18, data.length, true);
    view.setUint32(22, data.length, true);
    view.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    local.set(data, 30 + nameBytes.length);
    locals.push(local);

    const central = new Uint8Array(46 + nameBytes.length);
    const cview = new DataView(central.buffer);
    cview.setUint32(0, CEN_SIG, true);
    cview.setUint16(10, 0, true);
    cview.setUint32(20, data.length, true);
    cview.setUint32(24, data.length, true);
    cview.setUint16(28, nameBytes.length, true);
    cview.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    centrals.push(central);
    offset += local.length;
  }

  const centralSize = centrals.reduce((n, c) => n + c.length, 0);
  const eocd = new Uint8Array(22);
  const eview = new DataView(eocd.buffer);
  eview.setUint32(0, EOCD_SIG, true);
  eview.setUint16(8, files.length, true);
  eview.setUint16(10, files.length, true);
  eview.setUint32(12, centralSize, true);
  eview.setUint32(16, offset, true);

  const total = offset + centralSize + 22;
  const out = new Uint8Array(total);
  let at = 0;
  for (const local of locals) {
    out.set(local, at);
    at += local.length;
  }
  for (const central of centrals) {
    out.set(central, at);
    at += central.length;
  }
  out.set(eocd, at);
  return out;
}
