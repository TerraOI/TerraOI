import { describe, expect, it } from "vitest";

import { mapXlsxCellsToArtifacts } from "./artifact-mapper";
import { buildStoredZip } from "./ooxml-zip";
import { MAX_UPLOAD_BYTES, verifyCapturedObject, XLSX_MEDIA } from "./object-validator";
import { extractXlsx } from "./xlsx-extract";

function sha256Hex(bytes: Uint8Array): Promise<string> {
  return crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>).then((d) =>
    [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join(""),
  );
}

function syntheticXlsx(): Uint8Array {
  const shared = `<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="3" uniqueCount="3"><si><t>Payload capacity</t></si><si><t>Sheet2 label</t></si><si><t>120 kg</t></si></sst>`;
  // B7 under header from row 1 col B = shared string 0; value at B7 = shared string 2
  const sheet = `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
    <row r="1"><c r="B1" t="s"><v>0</v></c></row>
    <row r="7"><c r="B7" t="s"><v>2</v></c><c r="C7"><f>A1+A2</f><v>42</v></c></row>
  </sheetData></worksheet>`;
  const contentTypes = `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>`;
  return buildStoredZip([
    { name: "[Content_Types].xml", body: contentTypes },
    { name: "xl/sharedStrings.xml", body: shared },
    { name: "xl/worksheets/sheet1.xml", body: sheet },
  ]);
}

describe("extractXlsx (T-212)", () => {
  it("keeps sheet, row, column and header context for a citable cell", async () => {
    const result = await extractXlsx(syntheticXlsx());
    expect(result.outcome).toBe("extracted");
    const cell = result.cells.find((c) => c.column === "B" && c.row === 7);
    expect(cell).toBeDefined();
    expect(cell?.sheet).toBe("Sheet1");
    expect(cell?.header).toBe("Payload capacity");
    expect(cell?.value).toBe("120 kg");

    const mapped = mapXlsxCellsToArtifacts(result.cells);
    const artifact = mapped.find((a) => a.body_text === "120 kg");
    expect(artifact?.locator.table).toContain("Sheet1!B7");
    expect(artifact?.locator.table).toContain("Payload capacity");
  });

  it("reads formula cached values and never evaluates the formula", async () => {
    const result = await extractXlsx(syntheticXlsx());
    const formulaCell = result.cells.find((c) => c.column === "C" && c.row === 7);
    expect(formulaCell?.value).toBe("42");
    expect(result.notes).toContain("formula_cached_value_only");
  });

  it("capture accepts a synthetic XLSX", async () => {
    const bytes = syntheticXlsx();
    const verified = await verifyCapturedObject({
      read: { status: "ok", bytes },
      maxBytes: MAX_UPLOAD_BYTES,
      expectedSha256: await sha256Hex(bytes),
    });
    expect(verified.ok).toBe(true);
    expect(verified.mediaType).toBe(XLSX_MEDIA);
  });
});
