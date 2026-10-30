import { describe, expect, it } from "vite-plus/test";

import { sanitizeCommitSubject, sanitizeReplySuggestion } from "./textGenerationUtils.ts";

describe("sanitizeCommitSubject", () => {
  // regression: #19181 truncation split grapheme clusters at the subject limit
  it.each([
    { name: "an emoji", prefixLength: 71, character: "🚀" },
    { name: "an accented character", prefixLength: 71, character: "e\u0301" },
    { name: "a joined emoji", prefixLength: 65, character: "👨‍👩‍👧‍👦" },
  ])("keeps $name intact at the subject limit", ({ prefixLength, character }) => {
    const prefix = "a".repeat(prefixLength);

    expect(sanitizeCommitSubject(`${prefix}${character} more`)).toBe(prefix);
  });
});

describe("sanitizeReplySuggestion", () => {
  it.each([
    { raw: '  "Run the tests again"  ', expected: "Run the tests again" },
    { raw: "Ship it\nand also explain why", expected: "Ship it" },
    { raw: "Add   a\tchangelog entry", expected: "Add a changelog entry" },
    { raw: "   ", expected: "" },
  ])("normalizes $raw", ({ raw, expected }) => {
    expect(sanitizeReplySuggestion(raw)).toBe(expected);
  });

  it("caps a long suggestion so it fits the composer", () => {
    const sanitized = sanitizeReplySuggestion("word ".repeat(100));

    expect(sanitized.length).toBeLessThanOrEqual(200);
    expect(sanitized.endsWith("...")).toBe(true);
  });
});
