import { describe, expect, it } from "vitest";

import { IngestionJobPayload } from "@/contracts/ingestion-job";
import { buildSyntheticPdf, syntheticPngBytes } from "@/platform/knowledge/fixtures";
import { buildStoredZip } from "@/platform/knowledge/ooxml-zip";

import { createCloudExtractor } from "./cloud-extractor";

const BASE_PAYLOAD = IngestionJobPayload.parse({
  jobId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  organisationId: "11111111-1111-4111-8111-111111111111",
  sourceVersionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  stage: "extract",
  executor: "cloud_worker",
  dataClass: "internal",
  parserGeneration: "p1",
  indexGeneration: 1,
  attempt: 1,
  issuedAt: "2026-11-21T20:00:00.000Z",
});

function syntheticDocx(paragraphs: string[]): Uint8Array {
  const body = paragraphs
    .map((text, i) => {
      if (i === 0) {
        return `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>`;
      }
      return `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;
    })
    .join("");
  const documentXml = `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`;
  const contentTypes = `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;
  return buildStoredZip([
    { name: "[Content_Types].xml", body: contentTypes },
    { name: "word/document.xml", body: documentXml },
  ]);
}

describe("createCloudExtractor (T-211 × T-212)", () => {
  const extractor = createCloudExtractor();

  it("extracts a digital PDF into page-located artifacts", async () => {
    const bytes = await buildSyntheticPdf({
      pages: [
        {
          lines: [
            "Payload capacity stays under 120 kg on pad Alpha during the pre-flight check.",
          ],
        },
      ],
    });
    const result = await extractor.extract({ payload: BASE_PAYLOAD, bytes });
    expect(result.outcome).toBe("extracted");
    if (result.outcome !== "extracted") return;
    expect(result.artifacts.length).toBeGreaterThan(0);
    expect(result.artifacts[0]?.locator).toMatchObject({ page: 1 });
    expect(result.artifacts[0]?.bodyText).toContain("120 kg");
  });

  it("extracts DOCX with a section locator and no organisation field", async () => {
    const bytes = syntheticDocx(["3.2 Compass check", "Calibrate within 2 m of the pad."]);
    const result = await extractor.extract({ payload: BASE_PAYLOAD, bytes });
    expect(result.outcome).toBe("extracted");
    if (result.outcome !== "extracted") return;
    expect(result.artifacts.some((a) => a.bodyText.includes("2 m"))).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/organisation|organization/i);
  });

  it("retargets a PNG to the local box", async () => {
    const result = await extractor.extract({ payload: BASE_PAYLOAD, bytes: syntheticPngBytes() });
    expect(result).toMatchObject({
      outcome: "needs_local_box",
      reason: "unsupported_filter",
    });
  });

  it("refuses an empty object as unsupported", async () => {
    const result = await extractor.extract({ payload: BASE_PAYLOAD, bytes: new Uint8Array() });
    expect(result).toMatchObject({
      outcome: "unsupported",
      reason: "unsupported_document",
    });
  });
});
