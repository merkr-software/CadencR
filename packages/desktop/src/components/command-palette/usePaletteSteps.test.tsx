// @vitest-environment happy-dom
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyHaloAppearance,
  applyThemeToDocument,
  DEFAULT_HALO_OVERRIDE,
  getTheme,
} from "@/lib/themes";
import { usePaletteSteps, type PaletteStepsInput } from "./usePaletteSteps";

vi.mock("@/api/generated", () => ({
  useGetProjectSettings: () => ({ data: [] }),
  useListBranches: () => ({ data: [] }),
}));

vi.mock("@/hooks/useTheme", () => ({
  useTheme: () => ({
    themeId: "one-dark",
    followSystemTheme: false,
    setTheme: vi.fn(),
    setFollowSystemTheme: vi.fn(),
  }),
}));

vi.mock("@/hooks/useHaloOverride", () => ({
  useHaloOverride: () => ({
    override: { ...DEFAULT_HALO_OVERRIDE, enabled: true, grainOpacity: 0.36 },
  }),
}));

const input: PaletteStepsInput = {
  step: { kind: "theme" },
  text: "",
  selectedKey: "cmd:theme-frost-dark",
  projects: [],
  conversations: [],
  activeProjectId: null,
  ops: {
    openConversation: vi.fn(),
    createConversation: vi.fn(),
    addProject: vi.fn(),
    installCli: vi.fn(),
    setPinned: vi.fn(),
    restore: vi.fn(),
    openFile: vi.fn(),
    openMessage: vi.fn(),
  },
  context: {
    now: 0,
    activeProjectId: null,
    activeFeatureId: null,
    scope: "all",
    frecency: {},
    attention: new Map(),
    projectNames: new Map(),
  },
};

describe("command palette theme preview", () => {
  beforeEach(() => {
    applyThemeToDocument("one-dark");
    applyHaloAppearance(getTheme("one-dark"), { enabled: true, grainOpacity: 0.36 });
  });
  afterEach(cleanup);

  it("restores the user's added material when leaving without a selection", () => {
    const { rerender } = renderHook((props: PaletteStepsInput) => usePaletteSteps(props), {
      initialProps: input,
    });
    const root = document.documentElement;
    expect(root.dataset.theme).toBe("frost-dark");
    expect(root.hasAttribute("data-halo-fallback")).toBe(false);

    rerender({ ...input, step: null });
    expect(root.dataset.theme).toBe("one-dark");
    expect(root.hasAttribute("data-halo-fallback")).toBe(true);
    expect(root.dataset.textureBase).toBe("on");
    expect(root.style.getPropertyValue("--ambient-base")).not.toBe("");
    expect(root.style.getPropertyValue("--ambient-veil-opacity")).toBe("0.55");
  });

  it("restores the same material when the palette unmounts", () => {
    const { unmount } = renderHook(() => usePaletteSteps(input));
    unmount();
    expect(document.documentElement.dataset.theme).toBe("one-dark");
    expect(document.documentElement.dataset.textureBase).toBe("on");
    expect(document.documentElement.hasAttribute("data-halo-fallback")).toBe(true);
  });
});
