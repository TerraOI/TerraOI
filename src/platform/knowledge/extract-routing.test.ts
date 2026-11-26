import { describe, expect, it } from "vitest";

import { DOCX_MEDIA, XLSX_MEDIA } from "./object-validator";
import { decideExtractRoute } from "./extract-routing";

describe("decideExtractRoute (T-212 / #135)", () => {
  it("routes digital PDF, DOCX and XLSX to cloud_worker", () => {
    expect(decideExtractRoute({ mediaType: "application/pdf", textLayer: "ok" }).executor).toBe("cloud_worker");
    expect(decideExtractRoute({ mediaType: DOCX_MEDIA }).executor).toBe("cloud_worker");
    expect(decideExtractRoute({ mediaType: XLSX_MEDIA }).executor).toBe("cloud_worker");
  });

  it("routes images, scans and failed text layers to local_box", () => {
    expect(decideExtractRoute({ mediaType: "image/png" }).executor).toBe("local_box");
    expect(decideExtractRoute({ mediaType: "image/jpeg" }).executor).toBe("local_box");
    expect(decideExtractRoute({ mediaType: "image/tiff" }).executor).toBe("local_box");
    expect(decideExtractRoute({ mediaType: "image/heic" }).executor).toBe("local_box");
    expect(decideExtractRoute({ mediaType: "application/pdf", textLayer: "missing" }).executor).toBe("local_box");
    expect(decideExtractRoute({ mediaType: "application/pdf", textLayer: "low_quality" }).executor).toBe("local_box");
    expect(decideExtractRoute({ mediaType: "application/pdf", textLayer: "failed" }).executor).toBe("local_box");
  });

  it("refuses unsupported types without choosing an executor", () => {
    const decision = decideExtractRoute({ mediaType: "application/octet-stream" });
    expect(decision.executor).toBeNull();
    expect(decision.reason).toBe("unsupported_type");
  });
});
