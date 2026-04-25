import { describe, it, expect } from "vitest";
import { isFeedbackCommand } from "../../src/scoring/match.js";

describe("isFeedbackCommand", () => {
  const cases: Array<[string, boolean]> = [
    ["/feedback up", true],
    ["/feedback down great answer", true],
    ["/journey up", true],
    ["/journey down", true],
    ["/feedback", true], // bare command
    ["/journey", true], // bare command
    ["  /feedback up", true], // leading whitespace
    ["\t/feedback up", true], // leading tab
    ["/langfuse-tracing:feedback up", true], // namespaced form
    ["/langfuse-tracing:journey down", true],
    ["/feedbackish", false], // similar prefix
    ["/feedback-something", false], // hyphen extends the name
    ["/journey-style", false],
    ["I want to give /feedback up", false], // not at start
    ["", false],
    ["/help", false],
    ["/Feedback up", false], // case-sensitive on cmd name
    ["/FEEDBACK", false],
    ["/journey:foo", false], // colon doesn't extend the name
    ["/langfuse:feedback", false], // wrong namespace
  ];

  for (const [prompt, expected] of cases) {
    it(`${expected ? "matches" : "does not match"}: ${JSON.stringify(prompt)}`, () => {
      expect(isFeedbackCommand(prompt)).toBe(expected);
    });
  }
});
