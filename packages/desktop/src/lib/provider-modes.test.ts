import { afterEach, describe, expect, it } from "vitest";
import {
  PROVIDER_MODES,
  defaultEditModeFor,
  findProviderMode,
  getProviderModes,
  getVisibleModes,
  nextProviderMode,
  canReplayPermissionMode,
  providerAcceptsMode,
} from "./provider-modes";
import { setProviderCatalogMetadata } from "./provider-catalog-registry";
import { PROVIDER_IDS } from "./providers";

afterEach(() => setProviderCatalogMetadata([]));

describe("provider-modes catalog", () => {
  it("exposes the documented mode set per provider", () => {
    expect(PROVIDER_MODES[PROVIDER_IDS.CLAUDE_CODE].map((m) => m.id)).toEqual([
      "auto",
      "acceptEdits",
      "plan",
      "bypassPermissions",
    ]);
    expect(PROVIDER_MODES[PROVIDER_IDS.OPENCODE].map((m) => m.id)).toEqual(["acceptEdits", "plan"]);
    expect(PROVIDER_MODES[PROVIDER_IDS.CODEX_CLI].map((m) => m.id)).toEqual(["default", "plan"]);
  });

  it("exposes Claude bypass as an opt-in permission mode in the normal selector", () => {
    expect(findProviderMode(PROVIDER_IDS.CLAUDE_CODE, "bypassPermissions")?.optIn).toBe(true);
    expect(findProviderMode(PROVIDER_IDS.CLAUDE_CODE, "auto")?.optIn).toBeFalsy();
    expect(findProviderMode(PROVIDER_IDS.CODEX_CLI, "bypassPermissions")).toBeNull();
    expect(findProviderMode(PROVIDER_IDS.CODEX_CLI, "default")?.optIn).toBeFalsy();
  });

  it("returns an empty list for unknown provider ids so the chip hides", () => {
    // Avoids mislabeling unknown sessions with Claude's colors/labels — the
    // < 2 visible-modes gate in MetaBar drops the chip cleanly.
    expect(getProviderModes("does-not-exist")).toEqual([]);
    expect(getProviderModes(null)).toEqual([]);
    expect(getProviderModes(undefined)).toEqual([]);
  });
});

describe("getVisibleModes", () => {
  it("hides opt-in modes when their toggle is off", () => {
    const visible = getVisibleModes(PROVIDER_IDS.CLAUDE_CODE, []);
    expect(visible.map((m) => m.id)).toEqual(["auto", "acceptEdits", "plan"]);
  });

  it("adds Claude bypass to normal modes when explicitly enabled", () => {
    const visible = getVisibleModes(PROVIDER_IDS.CLAUDE_CODE, ["bypassPermissions"]);
    expect(visible.map((m) => m.id)).toEqual(["auto", "acceptEdits", "plan", "bypassPermissions"]);
  });

  it("does not leak opt-in modes from the wrong provider", () => {
    // OpenCode has no opt-in modes; passing one should be a no-op.
    const visible = getVisibleModes(PROVIDER_IDS.OPENCODE, ["bypassPermissions"]);
    expect(visible.map((m) => m.id)).toEqual(["acceptEdits", "plan"]);
  });

  it("adds project OpenCode agents to visible modes", () => {
    const catalogModes = [
      { id: "opencodeAgent:documentor" as const, label: "documentor" },
      {
        id: "opencodeAgent:scenario-builder" as const,
        label: "scenario-builder",
      },
    ];
    const visible = getVisibleModes(PROVIDER_IDS.OPENCODE, [], catalogModes);
    expect(visible.map((m) => m.id)).toEqual([
      "acceptEdits",
      "plan",
      "opencodeAgent:documentor",
      "opencodeAgent:scenario-builder",
    ]);
    expect(
      findProviderMode(PROVIDER_IDS.OPENCODE, "opencodeAgent:documentor", catalogModes)?.label,
    ).toBe("documentor");
  });

  it("builds installed provider modes from the catalog, styled by host mode id", () => {
    const catalogModes = [
      { id: "default" as const, label: "Agent", description: "Full tools." },
      { id: "plan" as const, label: "Plan" },
      { id: "ask" as const, label: "Ask" },
    ];
    const modes = getVisibleModes("cursor", [], catalogModes);
    expect(modes.map((mode) => [mode.id, mode.label, mode.risk])).toEqual([
      ["default", "Agent", "ask"],
      ["plan", "Plan", "read"],
      ["ask", "Ask", "read"],
    ]);
    expect(modes[0].description).toBe("Full tools.");
    expect(modes[1].description).toBe("Plan");
  });

  it("never gates catalog bypass modes behind an opt-in", () => {
    const catalogModes = [
      { id: "default" as const, label: "Default" },
      { id: "bypassPermissions" as const, label: "Yolo" },
    ];
    const modes = getVisibleModes("acme", [], catalogModes);
    expect(modes.map((mode) => mode.id)).toEqual(["default", "bypassPermissions"]);
    expect(modes[1].risk).toBe("bypass");
    expect(modes[1].optIn).toBeFalsy();
  });

  it("hides the chip for an installed provider with fewer than two catalog modes", () => {
    expect(getVisibleModes("acme", [], [{ id: "default", label: "Default" }])).toHaveLength(1);
    expect(getVisibleModes("acme", [], [])).toEqual([]);
  });

  it("falls back to the published catalog when the caller holds no modes", () => {
    setProviderCatalogMetadata([
      {
        id: "acme",
        label: "Acme",
        modes: [
          { id: "acceptEdits", label: "Build" },
          { id: "plan", label: "Plan" },
          { id: "not-a-host-mode", label: "Ignored" },
        ],
      },
    ]);
    expect(getProviderModes("acme").map((mode) => mode.id)).toEqual(["acceptEdits", "plan"]);
    expect(providerAcceptsMode("acme", "plan")).toBe(true);
    expect(providerAcceptsMode("acme", "auto")).toBe(false);
    expect(defaultEditModeFor("acme")).toBe("acceptEdits");
    expect(nextProviderMode("acme", "acceptEdits")).toBe("plan");
  });
});

describe("nextProviderMode (cycle)", () => {
  it("cycles through Claude Code's default 3 modes when bypass is off", () => {
    expect(nextProviderMode(PROVIDER_IDS.CLAUDE_CODE, "acceptEdits", [])).toBe("plan");
    expect(nextProviderMode(PROVIDER_IDS.CLAUDE_CODE, "plan", [])).toBe("auto");
    expect(nextProviderMode(PROVIDER_IDS.CLAUDE_CODE, "auto", [])).toBe("acceptEdits");
  });

  it("cycles Claude bypass after plan and before auto when explicitly enabled", () => {
    expect(nextProviderMode(PROVIDER_IDS.CLAUDE_CODE, "plan", ["bypassPermissions"])).toBe(
      "bypassPermissions",
    );
    expect(
      nextProviderMode(PROVIDER_IDS.CLAUDE_CODE, "bypassPermissions", ["bypassPermissions"]),
    ).toBe("auto");
    expect(nextProviderMode(PROVIDER_IDS.CLAUDE_CODE, "auto", ["bypassPermissions"])).toBe(
      "acceptEdits",
    );
  });

  it("two-mode toggle for OpenCode", () => {
    expect(nextProviderMode(PROVIDER_IDS.OPENCODE, "acceptEdits", [])).toBe("plan");
    expect(nextProviderMode(PROVIDER_IDS.OPENCODE, "plan", [])).toBe("acceptEdits");
  });

  it("cycles through OpenCode custom agents", () => {
    const customModes = [{ id: "opencodeAgent:documentor" as const, label: "documentor" }];
    expect(nextProviderMode(PROVIDER_IDS.OPENCODE, "plan", [], customModes)).toBe(
      "opencodeAgent:documentor",
    );
    expect(
      nextProviderMode(PROVIDER_IDS.OPENCODE, "opencodeAgent:documentor", [], customModes),
    ).toBe("acceptEdits");
  });

  it("Codex cycle: default → plan → wrap", () => {
    expect(nextProviderMode(PROVIDER_IDS.CODEX_CLI, "default", [])).toBe("plan");
    expect(nextProviderMode(PROVIDER_IDS.CODEX_CLI, "plan", [])).toBe("default");
    expect(nextProviderMode(PROVIDER_IDS.CODEX_CLI, "plan", ["bypassPermissions"])).toBe("default");
  });

  it("Shift+Tab cycles an installed provider's catalog modes in declared order", () => {
    const catalogModes = [
      { id: "default" as const, label: "Agent" },
      { id: "plan" as const, label: "Plan" },
      { id: "ask" as const, label: "Ask" },
    ];
    expect(nextProviderMode("cursor", "default", [], catalogModes)).toBe("plan");
    expect(nextProviderMode("cursor", "plan", [], catalogModes)).toBe("ask");
    expect(nextProviderMode("cursor", "ask", [], catalogModes)).toBe("default");
    expect(nextProviderMode("cursor", "auto", [], catalogModes)).toBe("default");
    expect(providerAcceptsMode("cursor", "ask", catalogModes)).toBe(true);
    expect(providerAcceptsMode("cursor", "acceptEdits", catalogModes)).toBe(false);
  });

  it("jumps to the head of the cycle when the current mode isn't in the provider's catalog", () => {
    // OpenCode's catalog is `["acceptEdits", "plan"]`; "auto" is a Claude-only
    // mode. nextProviderMode should not silently drop the call — it should
    // recover by selecting the first visible mode for the provider.
    expect(nextProviderMode(PROVIDER_IDS.OPENCODE, "auto", [])).toBe("acceptEdits");
  });
});

describe("defaultEditModeFor", () => {
  it("returns the first mode of each provider's catalog", () => {
    expect(defaultEditModeFor(PROVIDER_IDS.CLAUDE_CODE)).toBe("auto");
    expect(defaultEditModeFor(PROVIDER_IDS.OPENCODE)).toBe("acceptEdits");
    expect(defaultEditModeFor(PROVIDER_IDS.CODEX_CLI)).toBe("default");
  });

  it("uses an installed provider's first catalog mode as its primary edit mode", () => {
    const catalogModes = [
      { id: "default" as const, label: "Agent" },
      { id: "plan" as const, label: "Plan" },
    ];
    expect(defaultEditModeFor("cursor", catalogModes)).toBe("default");
    expect(defaultEditModeFor("unknown-provider")).toBe("acceptEdits");
  });
});

describe("canReplayPermissionMode", () => {
  it("replays any mode to built-ins and only declared modes to catalog providers", () => {
    expect(canReplayPermissionMode(PROVIDER_IDS.CODEX_CLI, "auto")).toBe(true);
    expect(canReplayPermissionMode("acme", "acceptEdits")).toBe(false);
    setProviderCatalogMetadata([
      {
        id: "acme",
        label: "Acme",
        modes: [{ id: "default", label: "Default" }],
      },
    ]);
    expect(canReplayPermissionMode("acme", "default")).toBe(true);
    expect(canReplayPermissionMode("acme", "acceptEdits")).toBe(false);
  });
});
