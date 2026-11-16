import { describe, expect, it } from "vitest";
import { authenticateBridgeCaller, featureBridgeToken } from "./browser-bridge-auth";

describe("browser bridge auth", () => {
  it("derives the same feature token as the service", () => {
    // Same vector as browser_bridge_scope.rs: both sides must agree.
    expect(featureBridgeToken("launch-secret", 42)).toBe(
      "fb1.42.OljfrXUARHvWR-yaEie8dwL9IOAF6oiZJgPLhoM1Upc",
    );
  });

  it("tells the service's launch token from a feature-scoped one", () => {
    expect(authenticateBridgeCaller("Bearer launch-secret", "launch-secret")).toEqual({
      kind: "service",
    });
    const scoped = featureBridgeToken("launch-secret", 7);
    expect(authenticateBridgeCaller(`Bearer ${scoped}`, "launch-secret")).toEqual({
      kind: "feature",
      featureId: 7,
    });
  });

  it("rejects a forged, retargeted or foreign token", () => {
    const scoped = featureBridgeToken("launch-secret", 7);
    const retargeted = scoped.replace("fb1.7.", "fb1.8.");
    for (const header of [
      "",
      "launch-secret",
      "Bearer wrong",
      `Bearer ${retargeted}`,
      `Bearer ${featureBridgeToken("other-launch", 7)}`,
    ]) {
      expect(authenticateBridgeCaller(header, "launch-secret")).toBeNull();
    }
  });
});
