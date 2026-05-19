import { describe, expect, it } from "vitest";
import { parsePermissionMode } from "./permission-mode";

describe("parsePermissionMode", () => {
  it("accepts every backend wire permission mode", () => {
    expect(parsePermissionMode("default")).toBe("default");
    expect(parsePermissionMode("acceptEdits")).toBe("acceptEdits");
    expect(parsePermissionMode("plan")).toBe("plan");
    expect(parsePermissionMode("auto")).toBe("auto");
    expect(parsePermissionMode("bypassPermissions")).toBe("bypassPermissions");
    expect(parsePermissionMode("dontAsk")).toBe("dontAsk");
  });

  it("accepts OpenCode agent modes", () => {
    expect(parsePermissionMode("opencodeAgent:documentor")).toBe("opencodeAgent:documentor");
  });

  it("rejects unknown and non-string values", () => {
    expect(parsePermissionMode("codex")).toBeNull();
    expect(parsePermissionMode("opencodeAgent:")).toBeNull();
    expect(parsePermissionMode(null)).toBeNull();
    expect(parsePermissionMode(undefined)).toBeNull();
  });
});
