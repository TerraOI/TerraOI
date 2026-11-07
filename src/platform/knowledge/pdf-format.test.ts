import { describe, expect, it } from "vitest";
import { hasFlateOutermost, isFlateOnlyChain, parseFilterChain, unsupportedFilterNote, UNREADABLE_FILTER } from "./pdf-format";

// The `/Filter` parser pinned at its own level (T-112e): dictionary strings, not documents. ISO
// 32000-1 §7.4 (Table 6) spells the entry as a name *or* an array, and the array order is the
// decoding order — the first name is the outermost filter. Every case is synthetic structure.

describe("parseFilterChain", () => {
  it("reads both spellings, however they are spaced", () => {
    expect(parseFilterChain("<< /Length 5 >>")).toEqual([]);
    expect(parseFilterChain("<< /Length 5 /Filter /FlateDecode >>")).toEqual(["FlateDecode"]);
    expect(parseFilterChain("<< /Length 5/Filter/FlateDecode >>")).toEqual(["FlateDecode"]);
    expect(parseFilterChain("<< /Filter[/FlateDecode] >>")).toEqual(["FlateDecode"]);
    expect(parseFilterChain("<< /Filter [ /FlateDecode ] >>")).toEqual(["FlateDecode"]);
    expect(parseFilterChain("<< /Filter [ /ASCII85Decode\n/LZWDecode\t] >>")).toEqual(["ASCII85Decode", "LZWDecode"]);
  });

  it("never reads a longer key that merely starts with Filter, or a /Filter inside a string", () => {
    expect(parseFilterChain("<< /Filtering /FlateDecode >>")).toEqual([]);
    expect(parseFilterChain("<< /Title (/Filter /LZWDecode) >>")).toEqual([]);
    expect(parseFilterChain("<< /Title <abc/Filter/LZWDecode> >>")).toEqual([]);
    expect(parseFilterChain("<< /Title (/Filter /LZWDecode) /Filter /FlateDecode >>")).toEqual(["FlateDecode"]);
    expect(parseFilterChain("<< /Length 5 /Filter /FlateDecode /Length1 3 >>")).toEqual(["FlateDecode"]);
  });

  it("resolves a nested DecodeParms filter the way the byte scan always has, and refuses it", () => {
    // First `/Filter` in the object dictionary wins, even inside DecodeParms: pinned as fail-closed
    // (`unsupported_filter_crypt`), not as correct. A stream-level `/Filter` written after
    // DecodeParms is therefore missed — refused, never mis-decoded, and what the old pattern did too.
    expect(parseFilterChain("<< /DecodeParms << /Filter /Crypt >> /Length 5 >>")).toEqual(["Crypt"]);
    expect(parseFilterChain("<< /DecodeParms << /Filter /Crypt >> /Length 5 /Filter /FlateDecode >>")).toEqual(["Crypt"]);
    expect(parseFilterChain("<< /DecodeParms << /Columns 7 >> /Filter /FlateDecode >>")).toEqual(["FlateDecode"]);
  });

  it("fails closed when /Filter is present but its value cannot be read", () => {
    for (const dict of ["<< /Filter [] >>", "<< /Filter / >>", "<< /Filter 12 0 R >>"]) {
      const chain = parseFilterChain(dict);
      expect(chain).toEqual([UNREADABLE_FILTER]);
      expect(isFlateOnlyChain(chain)).toBe(false);
      expect(hasFlateOutermost(chain)).toBe(false);
      expect(unsupportedFilterNote(chain)).toBe("unsupported_filter_unparsed");
    }
  });

  it("caps a hostile chain and every name, and meters only the outer hop", () => {
    const nine = ["RunLengthDecode", "LZWDecode", "DCTDecode", "JPXDecode", "CCITTFaxDecode", "JBIG2Decode", "Crypt", "FlateDecode", "Tail"];
    expect(parseFilterChain(`<< /Filter [${nine.map((name) => `/${name}`).join(" ")}] >>`)).toEqual(nine.slice(0, 8));
    expect(unsupportedFilterNote(nine)).toBe("unsupported_filter_chain_runlengthdecode_lzwdecode_dctdecode");
    expect(parseFilterChain(`<< /Filter /${"F".repeat(400)} >>`)).toEqual(["F".repeat(32)]);
    expect(isFlateOnlyChain(["FlateDecode"])).toBe(true);
    expect(isFlateOnlyChain(["FlateDecode", "ASCII85Decode"])).toBe(false);
    expect(hasFlateOutermost(["FlateDecode", "ASCII85Decode"])).toBe(true); // stored bytes are zlib
    expect(hasFlateOutermost(["ASCII85Decode", "FlateDecode"])).toBe(false); // ASCII85 text of zlib
    expect(hasFlateOutermost([])).toBe(false);
    expect(parseFilterChain("<< /Filter /Fl >>")).toEqual(["Fl"]); // PDF 1.1 alias: refused, not guessed
    expect(unsupportedFilterNote(["Fl"])).toBe("unsupported_filter_fl");
  });
});
