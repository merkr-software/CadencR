// @vitest-environment happy-dom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SIDEBAR_CONFIG } from "@/lib/sidebar-config";
import { useSidebarConfigStore } from "@/stores/sidebar-config-store";

const media = vi.hoisted(() => ({ matches: false, listeners: new Set<() => void>() }));

beforeAll(() => {
  vi.stubGlobal("matchMedia", (query: string) => ({
    media: query,
    get matches() {
      return media.matches;
    },
    addEventListener: (_: string, listener: () => void) => media.listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => media.listeners.delete(listener),
  }));
});

function resize(narrow: boolean): void {
  media.matches = narrow;
  act(() => media.listeners.forEach((listener) => listener()));
}

async function renderAutoCollapse(isMobile = false) {
  const { useSidebarAutoCollapse } = await import("./useSidebarAutoCollapse");
  return renderHook(() => useSidebarAutoCollapse(isMobile));
}

beforeEach(() => {
  media.matches = false;
  useSidebarConfigStore.setState({ config: { ...DEFAULT_SIDEBAR_CONFIG, autoCollapse: true } });
});

afterEach(() => {
  useSidebarConfigStore.setState({ config: DEFAULT_SIDEBAR_CONFIG });
});

describe("useSidebarAutoCollapse", () => {
  it("folds the sidebar while the window is narrow, only when switched on", async () => {
    const { result } = await renderAutoCollapse();
    expect(result.current.autoCollapsed).toBe(false);
    resize(true);
    expect(result.current.autoCollapsed).toBe(true);
    resize(false);
    expect(result.current.autoCollapsed).toBe(false);

    act(() => useSidebarConfigStore.setState({ config: DEFAULT_SIDEBAR_CONFIG }));
    resize(true);
    expect(result.current.autoCollapsed).toBe(false);
  });

  it("lets the user expand it while narrow until the window widens again", async () => {
    media.matches = true;
    const { result } = await renderAutoCollapse();
    expect(result.current.autoCollapsed).toBe(true);

    let handled = true;
    act(() => {
      handled = result.current.onUserToggle(false);
    });
    // Expanding still goes through to clear a stored collapse.
    expect(handled).toBe(false);
    expect(result.current.autoCollapsed).toBe(false);

    act(() => {
      handled = result.current.onUserToggle(true);
    });
    // Collapsing while narrow hands it back to the auto fold, unstored.
    expect(handled).toBe(true);
    expect(result.current.autoCollapsed).toBe(true);

    act(() => result.current.onUserToggle(false));
    resize(false);
    resize(true);
    expect(result.current.autoCollapsed).toBe(true);
  });

  it("leaves wide windows and phones alone", async () => {
    const { result } = await renderAutoCollapse();
    let handled = true;
    act(() => {
      handled = result.current.onUserToggle(true);
    });
    expect(handled).toBe(false);

    media.matches = true;
    const phone = await renderAutoCollapse(true);
    expect(phone.result.current.autoCollapsed).toBe(false);
  });
});
