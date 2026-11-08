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

  it("ignores a /Filter nested inside another dictionary and finds the stream's own entry", () => {
    // ISO 32000-1 §7.4.4: a parameter dictionary carries its *own* `/Filter` when it is itself
    // compressed (`DecodeParms << /Filter /Crypt >>`). A scan that does not count `<<`/`>>` depth
    // takes that nested name as the stream's chain, so a stream whose real chain is
    // `[/FlateDecode /ASCII85Decode]` reads as `[/FlateDecode]`: one hop inflated, the rest of the
    // chain never applied, and the bytes published as `extracted` with no note. The lead's
    // reproduction on #78, and the same fail-open class this PR exists to close.
    expect(parseFilterChain("<< /DecodeParms << /Filter /Crypt >> /Length 5 >>")).toEqual([]);
    expect(parseFilterChain("<< /DecodeParms << /Filter /Crypt >> /Length 5 /Filter /FlateDecode >>")).toEqual(["FlateDecode"]);
    expect(parseFilterChain("<< /Length 78 /DecodeParms << /Filter /FlateDecode >> /Filter [/FlateDecode /ASCII85Decode] >>")).toEqual([
      "FlateDecode",
      "ASCII85Decode",
    ]);
    expect(parseFilterChain("<< /Length 5 /Filter /FlateDecode /DecodeParms << /Filter /Crypt >> >>")).toEqual(["FlateDecode"]);
    expect(parseFilterChain("<< /DecodeParms << /Columns 7 >> /Filter /FlateDecode >>")).toEqual(["FlateDecode"]);
    // Two levels deep, and the decoy dictionary closed before the real key.
    expect(parseFilterChain("<< /DecodeParms << /X << /Filter /Crypt >> >> /Filter /LZWDecode >>")).toEqual(["LZWDecode"]);
    // A decoy that is the only `/Filter` in the object says nothing about this stream: the payload is
    // read as stored, which is the same answer as `<< /Length 5 >>`.
    expect(isFlateOnlyChain(parseFilterChain("<< /DecodeParms << /Filter /FlateDecode >> /Length 5 >>"))).toBe(false);
  });

  it("reads a % comment as a comment: a /Filter inside one is not a key", () => {
    // PDF 32000-1 §7.2.2: a comment runs from `%` to the end of the line and is not tokens. Skipping
    // literal and hex strings without skipping comments is the same mistake one character over.
    expect(parseFilterChain("<< /Length 4 % /Filter /FlateDecode\n >>")).toEqual([]);
    expect(parseFilterChain("<< /Length 4 % /Filter /FlateDecode\n /Filter /LZWDecode >>")).toEqual(["LZWDecode"]);
    expect(parseFilterChain("<< /Filter /FlateDecode % /DecodeParms << /Filter /Crypt >>\n >>")).toEqual(["FlateDecode"]);
    // The same rule inside a `/Filter` array: a name written in a comment is not one of this stream's
    // filters. Left unhandled, a comment would grow the chain and refuse (or un-meter) a stream that
    // is really single-filter — the benign direction, but the same mistake.
    expect(parseFilterChain("<< /Filter [ /FlateDecode % phantom /LZWDecode\n ] >>")).toEqual(["FlateDecode"]);
    expect(isFlateOnlyChain(parseFilterChain("<< /Filter [ /FlateDecode % phantom /LZWDecode\n ] >>"))).toBe(true);
    // A comment before the value is already legal and stays legal (the value reader skips it).
    expect(parseFilterChain("<< /Filter % leading comment\n /FlateDecode >>")).toEqual(["FlateDecode"]);
  });

  it("fails closed when /Filter is present but its value cannot be read", () => {
    // Every entry is a value a real generator would not write, and all four are fail-open if the
    // reader treats "I could not read it" as "there is no filter": the payload would be published as
    // stored text. `/Filter << … >>` is a dictionary where a name or array belongs.
    for (const dict of ["<< /Filter [] >>", "<< /Filter / >>", "<< /Filter 12 0 R >>", "<< /Filter << /K -1 >> >>"]) {
      const chain = parseFilterChain(dict);
      expect(chain).toEqual([UNREADABLE_FILTER]);
      expect(isFlateOnlyChain(chain)).toBe(false);
      expect(hasFlateOutermost(chain)).toBe(false);
      expect(unsupportedFilterNote(chain)).toBe("unsupported_filter_unparsed");
    }
  });

  it("refuses a dictionary that never closes instead of reading it as an unfiltered stream", () => {
    // The third sibling of the same rule. An unclosed nested dictionary hides the stream's own keys,
    // and `[]` means "no `/Filter`: stored as written", so the extractor would append whatever the
    // payload holds as text. A dictionary that does not balance has no readable keys at all, so it
    // reports the unreadable sentinel and every caller refuses it — fail closed, with a note.
    expect(parseFilterChain("<< /DecodeParms << /Filter /Crypt")).toEqual([UNREADABLE_FILTER]);
    expect(parseFilterChain("<< /DecodeParms << /K -1")).toEqual([UNREADABLE_FILTER]);
    expect(unsupportedFilterNote(parseFilterChain("<< /DecodeParms << /K -1"))).toBe("unsupported_filter_unparsed");
    expect(hasFlateOutermost(parseFilterChain("<< /DecodeParms << /K -1"))).toBe(false);
    // Balanced dictionaries keep their old answers: no `/Filter` is genuinely unfiltered, and the
    // dictionary's own `>>` ends the scan.
    expect(parseFilterChain("<< /Length 5 >>")).toEqual([]);
    expect(parseFilterChain("<< /Length 5 >> \n")).toEqual([]);
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
