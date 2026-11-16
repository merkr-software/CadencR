import { beforeEach, describe, expect, it } from "vitest";

import {
  getFocusedTab,
  selectFeatureLayout,
  useFeatureLayoutStore,
} from "@/stores/feature-layout-store";

import {
  activateBuiltinFeatureTab,
  builtinFallbacks,
  forgetReplacedTabs,
  isReplacementShown,
  setReplacedTabs,
  showBuiltinTab,
  showReplacementTab,
  useBuiltinTabFallbacks,
} from "./builtin-fallback";

const VCS = { git: "vcs" };

beforeEach(() => {
  useBuiltinTabFallbacks.setState({ replaced: {}, shown: {} });
  useFeatureLayoutStore.setState({ features: {} });
});

describe("built-in fallbacks", () => {
  it("brings back only a built-in a custom tab replaces in that conversation", () => {
    setReplacedTabs(7, VCS, VCS);
    setReplacedTabs(8, {}, {});
    showBuiltinTab(7, "editor");
    showBuiltinTab(7, "agent");
    showBuiltinTab(8, "git");
    expect(builtinFallbacks(7)).toEqual({});
    expect(builtinFallbacks(8)).toEqual({});
    showBuiltinTab(7, "git");
    showBuiltinTab(7, "git");
    expect(builtinFallbacks(7)).toEqual({ git: "vcs" });
  });

  it("switches back to the replacement", () => {
    const both = { git: "vcs", terminal: "sh" };
    setReplacedTabs(7, both, both);
    showBuiltinTab(7, "git");
    showBuiltinTab(7, "terminal");
    showReplacementTab(7, "git");
    expect(builtinFallbacks(7)).toEqual({ terminal: "sh" });
  });

  it("activates the built-in it brings back", () => {
    setReplacedTabs(7, { terminal: "sh" }, { terminal: "sh" });
    expect(activateBuiltinFeatureTab(7, "terminal")).toBe(true);
    expect(getFocusedTab(selectFeatureLayout(7)(useFeatureLayoutStore.getState()))).toBe(
      "terminal",
    );
    expect(builtinFallbacks(7)).toEqual({ terminal: "sh" });
  });

  it("keeps a built-in brought back before its page resolved", () => {
    // A PR opened from the sidebar for a conversation not shown yet.
    showBuiltinTab(7, "git");
    showBuiltinTab(7, "terminal");
    expect(builtinFallbacks(7)).toEqual({ git: null, terminal: null });
    setReplacedTabs(7, VCS, VCS);
    expect(builtinFallbacks(7)).toEqual({ git: "vcs" });
    expect(isReplacementShown(7, "git")).toBe(false);
  });

  it("forgets a fallback once its custom tab is no longer the one chosen", () => {
    setReplacedTabs(7, VCS, VCS);
    showBuiltinTab(7, "git");
    forgetReplacedTabs(7);
    // Chosen while the conversation was away: Forge isn't hidden.
    const forge = { git: "forge" };
    setReplacedTabs(7, forge, forge);
    expect(builtinFallbacks(7)).toEqual({});
    expect(isReplacementShown(7, "git")).toBe(true);
    showBuiltinTab(7, "git");
    setReplacedTabs(7, {}, {});
    setReplacedTabs(7, forge, forge);
    expect(isReplacementShown(7, "git")).toBe(true);
  });

  it("keeps a fallback while its custom tab can't run for a moment", () => {
    setReplacedTabs(7, VCS, VCS);
    showBuiltinTab(7, "git");
    // VCS rebuilding: still chosen, not shown.
    setReplacedTabs(7, {}, VCS);
    setReplacedTabs(7, VCS, VCS);
    expect(builtinFallbacks(7)).toEqual({ git: "vcs" });
    expect(isReplacementShown(7, "git")).toBe(false);
  });

  it("knows a place shows its replacement only while its page is there", () => {
    setReplacedTabs(7, { editor: "ide" }, { editor: "ide" });
    expect(isReplacementShown(7, "editor")).toBe(true);
    expect(isReplacementShown(7, "terminal")).toBe(false);
    showBuiltinTab(7, "editor");
    expect(isReplacementShown(7, "editor")).toBe(false);
    showReplacementTab(7, "editor");
    forgetReplacedTabs(7);
    expect(isReplacementShown(7, "editor")).toBe(false);
  });

  it("keeps the same state when nothing changed", () => {
    setReplacedTabs(7, VCS, VCS);
    const before = useBuiltinTabFallbacks.getState();
    setReplacedTabs(7, { git: "vcs" }, { git: "vcs" });
    expect(useBuiltinTabFallbacks.getState()).toBe(before);
  });
});
