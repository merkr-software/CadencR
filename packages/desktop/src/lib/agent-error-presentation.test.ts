import { describe, expect, it } from "vitest";
import { presentAgentError } from "./agent-error-presentation";

describe("presentAgentError", () => {
  it.each([
    [
      "ERROR_DURING_EXECUTION",
      "API Error: 529 overloaded",
      "The provider is overloaded or rate-limited",
    ],
    ["AGENT_ERROR", "Invalid API key · please run /login", "The agent's CLI isn't signed in"],
    [
      "AGENT_ERROR",
      "prompt is too long: 210000 tokens",
      "The conversation no longer fits the model's context",
    ],
    ["AGENT_STOPPED", "stream closed", "The agent process stopped unexpectedly"],
    ["UNKNOWN_MESSAGE", "raw", "Cadencr received an event it doesn't recognize"],
    ["ERROR_DURING_EXECUTION", "something else", "The agent hit an error and ended its turn"],
  ])("frames %s / %s", (code, content, title) => {
    expect(presentAgentError(code, content).title).toBe(title);
  });

  it("offers a model switch only where it helps", () => {
    expect(presentAgentError(undefined, "rate limit reached").actions).toEqual([
      "continue",
      "switchModel",
    ]);
    expect(presentAgentError(undefined, "boom").actions).toEqual(["continue"]);
  });
});
