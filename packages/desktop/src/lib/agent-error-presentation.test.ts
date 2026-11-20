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
    [
      "SETTINGS_READ_FAILED",
      "Failed to read the agent provider setting: rate limit",
      "Cadencr couldn't read a setting this conversation needs",
    ],
    ["ERROR_DURING_EXECUTION", "something else", "The agent hit an error and ended its turn"],
  ])("frames %s / %s", (code, content, title) => {
    expect(presentAgentError(code, content).title).toBe(title);
  });

  // Found in QA: a failed Codex fork read as an overload because the
  // app-server's "unknown variant" error lists `account/rateLimits/read`.
  it.each([
    [
      "BRANCH_SURGERY_FAILED",
      "The conversation couldn't be branched: transcript surgery failed: Codex app-server branching failed: app-server returned error -32600: Invalid request: unknown variant `thread/rollback`, expected one of `initialize`, `account/rateLimits/read`",
      "The conversation couldn't be rewound or forked",
    ],
    ["AGENT_STOPPED", "stderr: 429 Too Many Requests", "The agent process stopped unexpectedly"],
    [
      "PROVIDER_REQUEST_REJECTED",
      "Codex app-server returned error -32600: Invalid request: unknown variant `account/rateLimits/read`",
      "The agent's CLI rejected a request from Cadencr",
    ],
  ])("never frames a classified %s error from its wording", (code, content, title) => {
    const presentation = presentAgentError(code, content);
    expect(presentation.title).toBe(title);
    expect(presentation.actions).not.toContain("switchModel");
  });

  // Found in QA: an unreadable project settings file showed "ended its turn"
  // and a Continue button on a conversation that never had a turn.
  it("frames an unreadable setting as a settings error, not a turn to continue", () => {
    const presentation = presentAgentError(
      "SETTINGS_READ_FAILED",
      "Cadencr could not read the settings file /p/qa.settings.json: Is a directory",
    );
    expect(presentation.title).not.toMatch(/turn/i);
    expect(presentation.hint).not.toMatch(/turn/i);
    expect(presentation.actions).toEqual(["openSettings"]);
    expect(presentation.showCause).toBe(true);
  });

  it("offers a model switch only where it helps", () => {
    expect(presentAgentError(undefined, "rate limit reached").actions).toEqual([
      "continue",
      "switchModel",
    ]);
    expect(presentAgentError(undefined, "boom").actions).toEqual(["continue"]);
  });
});
