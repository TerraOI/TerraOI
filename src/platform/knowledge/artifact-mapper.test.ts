import { describe, expect, it } from "vitest";

import { mapDocxBlocksToArtifacts, mapPdfPagesToArtifacts, mapXlsxCellsToArtifacts } from "./artifact-mapper";

describe("artifact mapper (#135)", () => {
  it("maps DOCX blocks to section locators", () => {
    const artifacts = mapDocxBlocksToArtifacts([{ sectionPath: "1.2 / Limits", text: "Stay under 120 kg." }]);
    expect(artifacts[0]?.artifact_index).toBe(0);
    expect(artifacts[0]?.locator.section).toBe("1.2 / Limits");
    expect(artifacts[0]?.body_text).toContain("120 kg");
  });

  it("maps XLSX cells to table locators expressible under the SQL CHECK", () => {
    const artifacts = mapXlsxCellsToArtifacts([
      { sheet: "Sheet2", row: 7, column: "B", header: "Payload capacity", value: "80 kg" },
    ]);
    expect(artifacts[0]?.locator.table).toBe("Sheet2!B7 under header Payload capacity");
  });

  it("maps PDF pages to page locators", () => {
    const artifacts = mapPdfPagesToArtifacts([{ pageNumber: 3, text: "Synthetic note." }]);
    expect(artifacts[0]?.locator.page).toBe(3);
  });
});
