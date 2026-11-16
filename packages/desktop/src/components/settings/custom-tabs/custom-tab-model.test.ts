import { describe, expect, it } from "vitest";
import { apiErrorCode } from "@/lib/api-errors";
import { canTurnOn, customTabStatus, describeScope, enablementSummary } from "./custom-tab-model";
import { backendPlatforms } from "@/components/plugin-tabs/plugin-tab-access";
import { linuxOnlyBackendTab } from "@/components/plugin-tabs/plugin-tab-fixtures";
import { serviceError, tabFixture } from "./custom-tabs-fixtures";

const on = (global: boolean | null) =>
  tabFixture({ enablement: { global, project: null, effective: false, consent_required: false } });

describe("custom tab model", () => {
  it("only lets a valid tab be switched on", () => {
    expect(canTurnOn(tabFixture())).toBe(true);
    expect(canTurnOn(linuxOnlyBackendTab())).toBe(true);
    expect(canTurnOn(tabFixture({ status: "invalid" }))).toBe(false);
    expect(canTurnOn(tabFixture({ status: "blocked", blocked_reason: "Revoked." }))).toBe(false);
  });

  it("ranks an invalid manifest above a missing build", () => {
    expect(customTabStatus(tabFixture())).toBe("valid");
    expect(customTabStatus(tabFixture({ entry_present: false }))).toBe("not-built");
    expect(customTabStatus(tabFixture({ status: "invalid", entry_present: false }))).toBe(
      "invalid",
    );
  });

  it("ranks a blocked tab above everything else", () => {
    const blocked = { status: "blocked" as const, blocked_reason: "Exfiltrates tokens." };
    expect(customTabStatus(tabFixture({ ...blocked, entry_present: false }))).toBe("blocked");
    expect(customTabStatus(linuxOnlyBackendTab(blocked))).toBe("blocked");
  });

  it("ranks a backend with no build for this platform above a missing page build", () => {
    expect(customTabStatus(linuxOnlyBackendTab({ entry_present: false }))).toBe("unavailable");
    expect(customTabStatus(linuxOnlyBackendTab({ status: "invalid" }))).toBe("invalid");
    expect(customTabStatus(linuxOnlyBackendTab({ backend_availability: "available" }))).toBe(
      "valid",
    );
  });

  it("names the platforms a backend runs on", () => {
    const binary = (keys: string[]) => ({
      binary: Object.fromEntries(keys.map((key) => [key, `bin/${key}/x`])),
      protocol: 1,
    });
    expect(backendPlatforms(binary(["linux-x86_64"]))).toBe("Linux (x86-64)");
    expect(backendPlatforms(binary(["darwin-aarch64", "darwin-x86_64", "linux-x86_64"]))).toBe(
      "macOS (Apple silicon), macOS (Intel) and Linux (x86-64)",
    );
    expect(backendPlatforms(binary(["freebsd-x86_64"]))).toBe("freebsd-x86_64");
  });

  it("summarizes where a tab is switched on", () => {
    const ids = [1, 2, 3];
    expect(enablementSummary(on(null), new Map(), ids)).toBe("Off");
    expect(enablementSummary(on(true), new Map(), ids)).toBe("On everywhere");
    expect(enablementSummary(on(true), new Map([[2, false]]), ids)).toBe("On in 2 projects");
    expect(enablementSummary(on(false), new Map([[3, true]]), ids)).toBe("On in 1 project");
  });

  it("describes known scopes and flags unknown ones", () => {
    expect(describeScope("git:read").title).toBe("Git");
    expect(describeScope("teleport:write").description).toMatch(/does not know/);
  });

  it("reads service error codes", () => {
    expect(apiErrorCode(serviceError(409, "PLUGIN_TAB_CONSENT_STALE", "x"))).toBe(
      "PLUGIN_TAB_CONSENT_STALE",
    );
    expect(apiErrorCode(new Error("plain"))).toBeNull();
  });
});
