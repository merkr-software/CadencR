import { describe, expect, it } from "vitest";
import { createSessionInit } from "./ws-envelope";

describe("createSessionInit", () => {
  it("sends a null pair when the caller omits provider and model", () => {
    // A new session must let the backend resolve the pair: sending a
    // frontend fallback would be pinned and persisted as if deliberate.
    const env = createSessionInit({ cwd: "/tmp/x", featureId: 1 });

    expect(env.payload).toMatchObject({
      provider: null,
      model: null,
      thinking_effort: null,
      cwd: "/tmp/x",
      feature_id: 1,
    });
  });
});
