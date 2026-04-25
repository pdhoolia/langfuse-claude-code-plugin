import { describe, it, expect } from "vitest";
import { parseArgs, isParseError } from "../../src/scoring/parse.js";

describe("parseArgs", () => {
  it("rejects empty input", () => {
    const result = parseArgs("");
    expect(isParseError(result)).toBe(true);
  });

  it("rejects whitespace-only input", () => {
    const result = parseArgs("   ");
    expect(isParseError(result)).toBe(true);
  });

  it("parses 'up' alone", () => {
    const result = parseArgs("up");
    expect(result).toEqual({ direction: "up" });
  });

  it("parses 'down' alone", () => {
    const result = parseArgs("down");
    expect(result).toEqual({ direction: "down" });
  });

  it("is case-insensitive on direction (returns lowercase)", () => {
    expect(parseArgs("UP")).toEqual({ direction: "up" });
    expect(parseArgs("Down")).toEqual({ direction: "down" });
  });

  it("captures a single-word comment", () => {
    expect(parseArgs("up great")).toEqual({ direction: "up", comment: "great" });
  });

  it("captures a multi-word comment", () => {
    expect(parseArgs("up great answer")).toEqual({
      direction: "up",
      comment: "great answer",
    });
  });

  it("trims whitespace around the comment", () => {
    expect(parseArgs("down  too verbose  ")).toEqual({
      direction: "down",
      comment: "too verbose",
    });
  });

  it("preserves embedded whitespace inside the comment", () => {
    expect(parseArgs("down  the  output  was  truncated  ")).toEqual({
      direction: "down",
      comment: "the  output  was  truncated",
    });
  });

  it("rejects unknown direction", () => {
    const result = parseArgs("maybe");
    expect(isParseError(result)).toBe(true);
    if (isParseError(result)) {
      expect(result.error).toContain("maybe");
    }
  });

  it("rejects unknown direction even with a comment", () => {
    const result = parseArgs("sideways meh");
    expect(isParseError(result)).toBe(true);
  });
});
