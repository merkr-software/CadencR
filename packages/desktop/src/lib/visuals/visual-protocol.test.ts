import { describe, expect, it } from "vitest";
import { parseVisualFrameMessage } from "./visual-protocol";

describe("parseVisualFrameMessage", () => {
  it("accepts the shell's and the bridge's messages", () => {
    expect(parseVisualFrameMessage({ type: "cadencr-visual:ready" })).toEqual({
      type: "cadencr-visual:ready",
    });
    expect(parseVisualFrameMessage({ type: "cadencr-visual:size", height: 240 })).toEqual({
      type: "cadencr-visual:size",
      height: 240,
    });
    expect(parseVisualFrameMessage({ type: "cadencr-visual:error", message: "boom" })).toEqual({
      type: "cadencr-visual:error",
      message: "boom",
    });
  });

  it("rejects anything else posted to the window", () => {
    for (const data of [
      null,
      "cadencr-visual:ready",
      { type: "cadencr-visual:size", height: -1 },
      { type: "cadencr-visual:size", height: Number.POSITIVE_INFINITY },
      { type: "cadencr-visual:render", html: "<p>" },
      { type: "cadencr-visual:error", message: "x".repeat(5000) },
    ]) {
      expect(parseVisualFrameMessage(data)).toBeNull();
    }
  });
});
