import { describe, expect, it } from "vitest";

import { buildSyntheticPdf, sha256Hex, syntheticExecutableBytes, syntheticPngBytes, syntheticZipBytes, ascii, concatBytes } from "./fixtures";
import {
  MAX_DECOMPRESSED_BYTES,
  MAX_STREAMS_INSPECTED,
  MAX_UPLOAD_BYTES,
  sniffSignature,
  verifyCapturedObject,
  type CaptureOutcome,
  type UploadFailureReason,
} from "./object-validator";

// T-112 capture verification (plan §7.2 steps 1–2, §9.2.1): the bytes decide everything. A file
// name, a declared size or a declared hash is a claim; the signature, the measured size and the
// recomputed digest are the facts. A failure never produces a source row, and never an empty
// "successful" source either.

async function expectRefusal(input: Parameters<typeof verifyCapturedObject>[0]): Promise<{
  reason: UploadFailureReason;
  outcome: CaptureOutcome;
}> {
  const result = await verifyCapturedObject(input);
  expect(result.ok, "capture must not be accepted").toBe(false);
  if (result.ok) throw new Error("unreachable");
  expect(result.reason).toBeTruthy();
  return { reason: result.reason as UploadFailureReason, outcome: result.outcome };
}

describe("sniffSignature", () => {
  it("types a PDF by its header, not by its name", () => {
    expect(sniffSignature(ascii("%PDF-1.7\n")).mediaType).toBe("application/pdf");
  });

  it("names the PE header a renamed .exe actually carries", () => {
    const guess = sniffSignature(syntheticExecutableBytes());
    expect(guess.family).toBe("portable_executable");
    expect(guess.mediaType).not.toBe("application/pdf");
  });

  it("recognises a ZIP container (DOCX/XLSX are ZIP; T-212 owns them) and a PNG", () => {
    expect(sniffSignature(syntheticZipBytes()).family).toBe("zip");
    expect(sniffSignature(syntheticPngBytes()).family).toBe("image");
  });

  it("an empty object has no signature at all", () => {
    const guess = sniffSignature(new Uint8Array());
    expect(guess.family).toBe("unknown");
    expect(guess.mediaType).toBeNull();
  });
});

describe("verifyCapturedObject", () => {
  it("accepts a real digital PDF and reports its detected type and measured size", async () => {
    const bytes = await buildSyntheticPdf({ pages: [{ lines: ["Synthetic pre-flight note."] }] });
    const result = await verifyCapturedObject({
      read: { status: "ok", bytes },
      maxBytes: MAX_UPLOAD_BYTES,
      expectedSha256: await sha256Hex(bytes),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.mediaType).toBe("application/pdf");
    expect(result.sizeBytes).toBe(bytes.byteLength);
    expect(result.reason).toBeNull();
  });

  it("the declared hash is only a claim: a mismatch is refused (F10)", async () => {
    const bytes = await buildSyntheticPdf({});
    const wrong = await sha256Hex(concatBytes([bytes, ascii("tampered")]));
    const { reason, outcome } = await expectRefusal({
      read: { status: "ok", bytes },
      maxBytes: MAX_UPLOAD_BYTES,
      expectedSha256: wrong,
    });
    expect(reason).toBe("hash_mismatch");
    expect(outcome).toBe("failed");
  });

  it("a 0-byte object is refused, never an empty successful source", async () => {
    const { reason, outcome } = await expectRefusal({
      read: { status: "ok", bytes: new Uint8Array() },
      maxBytes: MAX_UPLOAD_BYTES,
      expectedSha256: await sha256Hex(new Uint8Array()),
    });
    expect(reason).toBe("empty_object");
    expect(outcome).toBe("failed");
  });

  it("an object larger than the session bound is refused without reading it whole", async () => {
    const { reason, outcome } = await expectRefusal({
      read: { status: "oversize", sizeBytes: MAX_UPLOAD_BYTES + 1 },
      maxBytes: MAX_UPLOAD_BYTES,
      expectedSha256: "0".repeat(64),
    });
    expect(reason).toBe("size_exceeded");
    expect(outcome).toBe("failed");
  });

  it("a .pdf that is really an .exe is quarantined by its signature", async () => {
    const bytes = syntheticExecutableBytes();
    const { reason, outcome } = await expectRefusal({
      read: { status: "ok", bytes },
      maxBytes: MAX_UPLOAD_BYTES,
      expectedSha256: await sha256Hex(bytes),
    });
    expect(reason).toBe("signature_mismatch");
    expect(outcome).toBe("quarantined");
  });

  it("a PNG or a ZIP is not ingested as a document by this packet (T-211/T-212 own those)", async () => {
    for (const bytes of [syntheticZipBytes(), syntheticPngBytes()]) {
      const { reason, outcome } = await expectRefusal({
        read: { status: "ok", bytes },
        maxBytes: MAX_UPLOAD_BYTES,
        expectedSha256: await sha256Hex(bytes),
      });
      expect(reason).toBe("unsupported_type");
      expect(outcome).toBe("quarantined");
    }
  });

  it("an encrypted PDF is quarantined rather than decrypted or indexed", async () => {
    const bytes = await buildSyntheticPdf({ encrypted: true, pages: [{ lines: ["Sealed synthetic text."] }] });
    const { reason, outcome } = await expectRefusal({
      read: { status: "ok", bytes },
      maxBytes: MAX_UPLOAD_BYTES,
      expectedSha256: await sha256Hex(bytes),
    });
    expect(reason).toBe("encrypted_pdf");
    expect(outcome).toBe("quarantined");
  });

  it("a stream that expands past the decompression budget is quarantined (plan §7.2 step 2)", async () => {
    const bytes = await buildSyntheticPdf({
      pages: [{ lines: ["Synthetic ordinary page."] }, { compressed: true, lines: ["Synthetic exploding page."] }],
      expandContentToBytes: 2_000_000,
    });
    expect(bytes.byteLength).toBeLessThan(200_000); // small file, enormous expansion
    const { reason, outcome } = await expectRefusal({
      read: { status: "ok", bytes },
      maxBytes: MAX_UPLOAD_BYTES,
      expectedSha256: await sha256Hex(bytes),
      limits: { maxDecompressedBytes: 200_000 },
    });
    expect(reason).toBe("decompression_bomb");
    expect(outcome).toBe("quarantined");
  });

  // T-112 follow-up, found in lead review of #54: the budget loop only recognised `/Filter` written
  // as a name, so `/Filter [/FlateDecode]` — legal, and emitted by real writers — escaped the
  // decompression budget entirely (plan §7.2 step 2, the ZIP-bomb bound).

  it("a bomb in an array-form FlateDecode stream is quarantined too", async () => {
    const bytes = await buildSyntheticPdf({
      pages: [
        { lines: ["Synthetic ordinary page."] },
        { compressed: true, filterSyntax: "array", lines: ["Synthetic exploding page."] },
      ],
      expandContentToBytes: 2_000_000,
    });
    expect(bytes.byteLength).toBeLessThan(200_000);
    const { reason, outcome } = await expectRefusal({
      read: { status: "ok", bytes },
      maxBytes: MAX_UPLOAD_BYTES,
      expectedSha256: await sha256Hex(bytes),
      limits: { maxDecompressedBytes: 200_000 },
    });
    expect(reason).toBe("decompression_bomb");
    expect(outcome).toBe("quarantined");
  });

  it("a multi-filter chain whose outermost filter is FlateDecode is metered as well", async () => {
    // The first name in a `/Filter` array is the outermost filter, i.e. the one applied first when
    // decoding, so these bytes really are a zlib stream and really can explode — whether or not the
    // rest of the chain is ever decoded.
    const bytes = await buildSyntheticPdf({
      pages: [
        { lines: ["Synthetic ordinary page."] },
        { compressed: true, filters: ["FlateDecode", "ASCII85Decode"], lines: ["Synthetic exploding page."] },
      ],
      expandContentToBytes: 2_000_000,
    });
    const { reason, outcome } = await expectRefusal({
      read: { status: "ok", bytes },
      maxBytes: MAX_UPLOAD_BYTES,
      expectedSha256: await sha256Hex(bytes),
      limits: { maxDecompressedBytes: 200_000 },
    });
    expect(reason).toBe("decompression_bomb");
    expect(outcome).toBe("quarantined");
  });

  it("an array-form FlateDecode stream within the budget still verifies", async () => {
    const bytes = await buildSyntheticPdf({
      pages: [{ compressed: true, filterSyntax: "array_spaced", lines: ["Synthetic compressed page."] }],
    });
    const result = await verifyCapturedObject({
      read: { status: "ok", bytes },
      maxBytes: MAX_UPLOAD_BYTES,
      expectedSha256: await sha256Hex(bytes),
    });
    expect(result.ok).toBe(true);
    expect(result.notes.filter((note) => note.startsWith("unsupported_filter_"))).toEqual([]);
  });

  it("a filter chain nothing here can inflate is named, never silently uncounted", async () => {
    // `/Filter [/ASCII85Decode /FlateDecode]`: the stored bytes are ASCII85 text of a zlib stream, so
    // no inflation is possible at capture and the volume cannot be metered. The object is still an
    // ordinary PDF, so it is accepted — but with a note that says which part was never measured.
    const bytes = await buildSyntheticPdf({
      pages: [{ compressed: true, filters: ["ASCII85Decode", "FlateDecode"], lines: ["Synthetic chain-encoded page."] }],
    });
    const result = await verifyCapturedObject({
      read: { status: "ok", bytes },
      maxBytes: MAX_UPLOAD_BYTES,
      expectedSha256: await sha256Hex(bytes),
    });
    expect(result.ok).toBe(true);
    expect(result.notes).toContain("unsupported_filter_chain_ascii85decode_flatedecode");
  });

  it("a single filter this parser does not implement is named in the notes too", async () => {
    const bytes = await buildSyntheticPdf({
      pages: [{ filters: ["LZWDecode"], lines: ["Synthetic page with an LZW content stream."] }],
    });
    const result = await verifyCapturedObject({
      read: { status: "ok", bytes },
      maxBytes: MAX_UPLOAD_BYTES,
      expectedSha256: await sha256Hex(bytes),
    });
    expect(result.ok).toBe(true);
    expect(result.notes).toContain("unsupported_filter_lzwdecode");
  });

  it("a bomb placed past the structural scan cap is refused, not half-checked (fail-closed scan)", async () => {
    // The budget here is *larger* than the payload, so the byte budget alone would pass this file:
    // the only thing that can refuse it is knowing that the scan stopped before the last object.
    const bytes = await buildSyntheticPdf({
      pages: [{ lines: ["Synthetic ordinary page."] }],
      fillerStreams: MAX_STREAMS_INSPECTED,
      bombStreamBytes: 4_000_000,
    });
    expect(bytes.byteLength).toBeLessThan(2_000_000);
    const { reason, outcome } = await expectRefusal({
      read: { status: "ok", bytes },
      maxBytes: MAX_UPLOAD_BYTES,
      expectedSha256: await sha256Hex(bytes),
      limits: { maxDecompressedBytes: 8_000_000 },
    });
    expect(reason).toBe("scan_truncated");
    expect(outcome).toBe("quarantined");
  });

  it("the budgets are finite and metered to the pilot goal, never unlimited", () => {
    expect(MAX_UPLOAD_BYTES).toBeGreaterThan(0);
    expect(MAX_UPLOAD_BYTES).toBeLessThanOrEqual(25 * 1024 * 1024); // plan §7.5: 20 MB pilot document
    expect(MAX_DECOMPRESSED_BYTES).toBeGreaterThan(MAX_UPLOAD_BYTES); // a real PDF inflates, a bomb explodes
  });

  it("a truncated tail is a malformed PDF, not an empty one", async () => {
    const bytes = await buildSyntheticPdf({ missingEof: true });
    const { reason, outcome } = await expectRefusal({
      read: { status: "ok", bytes },
      maxBytes: MAX_UPLOAD_BYTES,
      expectedSha256: await sha256Hex(bytes),
    });
    expect(reason).toBe("malformed_pdf");
    expect(outcome).toBe("quarantined");
  });

  it("a missing object is a conflict, not a capture", async () => {
    const { reason } = await expectRefusal({
      read: { status: "missing" },
      maxBytes: MAX_UPLOAD_BYTES,
      expectedSha256: "0".repeat(64),
    });
    expect(reason).toBe("object_missing");
  });

  it("active content is noted as refused, and the object still captures (AGENTS.md §4.8)", async () => {
    const bytes = await buildSyntheticPdf({
      javascript: "app.alert('TerraOI_CANARY');",
      launch: true,
      embeddedFile: true,
      pages: [{ lines: ["Synthetic manual with a script action."] }],
    });
    const result = await verifyCapturedObject({
      read: { status: "ok", bytes },
      maxBytes: MAX_UPLOAD_BYTES,
      expectedSha256: await sha256Hex(bytes),
    });
    expect(result.ok).toBe(true);
    expect(result.notes).toContain("active_content_refused");
    expect(result.notes).toContain("embedded_files_refused");
    // Nothing in the file decides the type or the key; only the bytes and the server do.
    expect(result.mediaType).toBe("application/pdf");
  });

  it("the byte budget is the session bound, whatever the client declared", async () => {
    const bytes = await buildSyntheticPdf({ pages: [{ lines: ["Small but over this session's bound."] }] });
    const { reason } = await expectRefusal({
      read: { status: "ok", bytes },
      maxBytes: 32, // a tiny session bound: the stored object is bigger than what this session may hold
      expectedSha256: await sha256Hex(bytes),
    });
    expect(reason).toBe("size_exceeded");
  });
});
