import { deflateRawSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { extractDocx } from "./docx-extract";
import { DOCX_MEDIA, MAX_UPLOAD_BYTES, verifyCapturedObject } from "./object-validator";
import { readZipEntries } from "./ooxml-zip";

// T-212 adversarial ZIP cases (supervisor review of #224, B1). Every package here is built with
// method 8 (raw DEFLATE), which is what real Word and Excel files use; the stored-only fixtures in
// docx-extract.test.ts never exercise the inflate path.

const LOC_SIG = 0x04034b50;
const CEN_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;

interface ZipPart {
  name: string;
  data: Uint8Array;
  /** Override the uncompressed size the central directory declares (a lying header). */
  declaredSize?: number;
}

interface BuildOptions {
  /** Extra central-directory records that all point at the first local header (overlap bomb). */
  overlapCopies?: number;
  /** Point the first central record's local header offset past the end of the file. */
  badLocalOffset?: boolean;
}

function buildDeflatedZip(parts: ZipPart[], options: BuildOptions = {}): Uint8Array {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  const central = (nameBytes: Uint8Array, compSize: number, size: number, at: number): Uint8Array => {
    const record = new Uint8Array(46 + nameBytes.length);
    const view = new DataView(record.buffer);
    view.setUint32(0, CEN_SIG, true);
    view.setUint16(10, 8, true);
    view.setUint32(20, compSize, true);
    view.setUint32(24, size, true);
    view.setUint16(28, nameBytes.length, true);
    view.setUint32(42, at, true);
    record.set(nameBytes, 46);
    return record;
  };

  for (const part of parts) {
    const nameBytes = encoder.encode(part.name);
    const compressed = new Uint8Array(deflateRawSync(part.data));
    const local = new Uint8Array(30 + nameBytes.length + compressed.length);
    const view = new DataView(local.buffer);
    view.setUint32(0, LOC_SIG, true);
    view.setUint16(8, 8, true);
    view.setUint32(18, compressed.length, true);
    view.setUint32(22, part.data.length, true);
    view.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    local.set(compressed, 30 + nameBytes.length);
    locals.push(local);
    centrals.push(central(nameBytes, compressed.length, part.declaredSize ?? part.data.length, offset));
    offset += local.length;
  }

  if (options.overlapCopies !== undefined && parts[0] !== undefined) {
    const first = parts[0];
    const nameBytes = encoder.encode(first.name);
    const compSize = new Uint8Array(deflateRawSync(first.data)).length;
    for (let i = 0; i < options.overlapCopies; i++) {
      centrals.push(central(nameBytes, compSize, first.data.length, 0));
    }
  }
  if (options.badLocalOffset && centrals[0] !== undefined) {
    new DataView(centrals[0].buffer).setUint32(42, 0x7fffffff, true);
  }

  const centralSize = centrals.reduce((n, c) => n + c.length, 0);
  const eocd = new Uint8Array(22);
  const eview = new DataView(eocd.buffer);
  eview.setUint32(0, EOCD_SIG, true);
  eview.setUint16(8, centrals.length, true);
  eview.setUint16(10, centrals.length, true);
  eview.setUint32(12, centralSize, true);
  eview.setUint32(16, offset, true);

  const out = new Uint8Array(offset + centralSize + 22);
  let at = 0;
  for (const chunk of [...locals, ...centrals, eocd]) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

const CONTENT_TYPES = new TextEncoder().encode(
  `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
);

function documentXml(text: string): Uint8Array {
  return new TextEncoder().encode(
    `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
      `<w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`,
  );
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function capture(bytes: Uint8Array, maxDecompressedBytes?: number) {
  return verifyCapturedObject({
    read: { status: "ok", bytes },
    maxBytes: MAX_UPLOAD_BYTES,
    expectedSha256: await sha256Hex(bytes),
    ...(maxDecompressedBytes === undefined ? {} : { limits: { maxDecompressedBytes } }),
  });
}

describe("OOXML ZIP reader: real (deflated) packages", () => {
  it("captures and extracts a DOCX whose parts are raw-DEFLATE compressed, as Word writes them", async () => {
    const bytes = buildDeflatedZip([
      { name: "[Content_Types].xml", data: CONTENT_TYPES },
      { name: "word/document.xml", data: documentXml("Calibrate within 2 m of the pad.") },
    ]);
    const verified = await capture(bytes);
    expect(verified.ok).toBe(true);
    expect(verified.mediaType).toBe(DOCX_MEDIA);
    const extracted = await extractDocx(bytes);
    expect(extracted.outcome).toBe("extracted");
    expect(extracted.blocks[0]?.text).toBe("Calibrate within 2 m of the pad.");
  });
});

describe("OOXML ZIP reader: decompression bombs and malformed packages (plan §7.2 step 2)", () => {
  const BUDGET = 1024 * 1024;
  // 4 MiB of one repeated byte deflates to a few KiB: the classic ratio bomb.
  const bomb = new Uint8Array(4 * BUDGET).fill(0x41);

  it("quarantines a part that inflates past the decompression budget", async () => {
    const bytes = buildDeflatedZip([
      { name: "[Content_Types].xml", data: CONTENT_TYPES },
      { name: "word/document.xml", data: bomb },
    ]);
    expect(bytes.length).toBeLessThan(BUDGET);
    const result = await capture(bytes, BUDGET);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("decompression_bomb");
    expect(result.outcome).toBe("quarantined");
  });

  it("refuses an entry whose declared size lies small, instead of trusting the header", async () => {
    const zip = buildDeflatedZip([
      { name: "[Content_Types].xml", data: CONTENT_TYPES },
      { name: "word/document.xml", data: bomb, declaredSize: 1 },
    ]);
    const read = await readZipEntries(zip, 64 * BUDGET);
    expect(read).toEqual({ ok: false, reason: "bomb" });
  });

  it("charges overlapping entries against one shared budget (non-recursive overlap bomb)", async () => {
    // Each record alone inflates to 256 KiB, under the 1 MiB budget; 16 records pointing at the same
    // local header are 4 MiB together.
    const quarter = new Uint8Array(BUDGET / 4).fill(0x42);
    const zip = buildDeflatedZip([{ name: "word/document.xml", data: quarter }], { overlapCopies: 15 });
    const single = await readZipEntries(buildDeflatedZip([{ name: "word/document.xml", data: quarter }]), BUDGET);
    expect(single.ok).toBe(true);
    const read = await readZipEntries(zip, BUDGET);
    expect(read).toEqual({ ok: false, reason: "bomb" });
  });

  it("refuses a central record whose local header offset points past the end of the file", async () => {
    const zip = buildDeflatedZip(
      [
        { name: "[Content_Types].xml", data: CONTENT_TYPES },
        { name: "word/document.xml", data: documentXml("x") },
      ],
      { badLocalOffset: true },
    );
    expect(await readZipEntries(zip, BUDGET)).toEqual({ ok: false, reason: "malformed" });
    const result = await capture(zip, BUDGET);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("unsupported_type");
  });

  it("refuses a truncated package (no end-of-central-directory record) without throwing", async () => {
    const zip = buildDeflatedZip([{ name: "word/document.xml", data: documentXml("x") }]);
    const truncated = zip.subarray(0, zip.length - 30);
    expect(await readZipEntries(truncated, BUDGET)).toEqual({ ok: false, reason: "malformed" });
  });
});

describe("DOCX entity decoding", () => {
  it("decodes each entity once: an escaped ampersand never becomes markup", async () => {
    const bytes = buildDeflatedZip([
      { name: "[Content_Types].xml", data: CONTENT_TYPES },
      { name: "word/document.xml", data: documentXml("A &amp;#60;b&amp;#62; &#x1F6F0; &lt;ok&gt;") },
    ]);
    const extracted = await extractDocx(bytes);
    expect(extracted.blocks[0]?.text).toBe("A &#60;b&#62; \u{1F6F0} <ok>");
  });
});
