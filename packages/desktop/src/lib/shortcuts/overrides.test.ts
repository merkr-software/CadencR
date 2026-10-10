// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { renderHook, act } from "@testing-library/react";

import { useResolvedShortcut, useShortcutOverridesStore } from "./overrides";

afterEach(() => {
  useShortcutOverridesStore.getState().resetAll();
});

describe("overrides store", () => {
  it("re-binds when setOverride is called and restores on clearOverride", () => {
    const { result } = renderHook(() => useResolvedShortcut("toggle-sidebar"));
    expect(result.current.keys).toEqual(["mod", "b"]);

    act(() => {
      useShortcutOverridesStore.getState().setOverride("toggle-sidebar", {
        keys: ["mod", "shift", "b"],
      });
    });
    expect(result.current.keys).toEqual(["mod", "shift", "b"]);

    act(() => {
      useShortcutOverridesStore.getState().clearOverride("toggle-sidebar");
    });
    expect(result.current.keys).toEqual(["mod", "b"]);
  });

  it("resetAll empties every override at once", () => {
    const store = useShortcutOverridesStore.getState();
    store.setOverride("toggle-sidebar", { keys: ["mod", "shift", "b"] });
    store.setOverride("command-palette", { keys: ["mod", "shift", "k"] });
    store.resetAll();
    expect(store.overrides).toEqual({});
  });
});

describe("useResolvedShortcut", () => {
  it.each([
    ["diff-next-file", "git-next-item"],
    ["diff-prev-file", "git-previous-item"],
    ["diff-toggle-file", "git-open-item"],
    ["diff-scroll-down", "git-scroll-down"],
    ["diff-scroll-up", "git-scroll-up"],
    ["diff-mark-viewed", "git-toggle-viewed"],
    ["diff-open-focused-file", "git-open-in-editor"],
  ] as const)("reads stored %s overrides through %s", (legacyId, replacementId) => {
    useShortcutOverridesStore.setState({
      overrides: { [legacyId]: { keys: ["ctrl", "j"] } },
    });

    const { result } = renderHook(() => useResolvedShortcut(replacementId));

    expect(result.current.keys).toEqual(["ctrl", "j"]);
  });

  it("migrates a legacy override when the replacement id is rebound", () => {
    useShortcutOverridesStore.setState({
      overrides: { "diff-next-file": { keys: ["ctrl", "j"] } },
    });

    act(() => {
      useShortcutOverridesStore.getState().setOverride("git-next-item", { keys: ["alt", "j"] });
    });

    expect(useShortcutOverridesStore.getState().overrides).toEqual({
      "git-next-item": { keys: ["alt", "j"] },
    });
  });

  it("does NOT re-render when an unrelated override changes (narrow selector)", () => {
    let renders = 0;
    renderHook(() => {
      renders += 1;
      return useResolvedShortcut("toggle-sidebar");
    });
    const baseline = renders;

    act(() => {
      useShortcutOverridesStore.getState().setOverride("command-palette", {
        keys: ["mod", "shift", "k"],
      });
    });
    expect(renders).toBe(baseline);
  });
});
