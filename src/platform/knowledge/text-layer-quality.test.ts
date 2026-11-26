import { describe, expect, it } from "vitest";

import { assessTextLayerQuality } from "./text-layer-quality";

describe("assessTextLayerQuality", () => {
  it("marks empty extraction as missing", () => {
    expect(assessTextLayerQuality({ outcome: "no_text_layer", text: "", pageCount: 2 })).toBe("missing");
    expect(assessTextLayerQuality({ outcome: "extracted", text: "   ", pageCount: 1 })).toBe("missing");
  });

  it("marks sparse text as low_quality", () => {
    expect(assessTextLayerQuality({ outcome: "extracted", text: "short", pageCount: 1 })).toBe("low_quality");
  });

  it("accepts a dense digital layer", () => {
    const text = "x".repeat(80);
    expect(assessTextLayerQuality({ outcome: "extracted", text, pageCount: 1 })).toBe("ok");
  });
});
