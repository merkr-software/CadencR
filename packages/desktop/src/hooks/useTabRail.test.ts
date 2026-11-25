// @vitest-environment happy-dom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// Each source with its own listeners, so a missing or leaked subscription shows.
const stores = vi.hoisted(() => ({
  strip: { side: null as "left" | "right" | null, listeners: new Set<() => void>() },
  layout: { wide: false, listeners: new Set<() => void>() },
}));

vi.mock("@/lib/side-strip", () => ({
  getSideStripSnapshot: () => stores.strip.side,
  subscribeSideStrip: (listener: () => void) => {
    stores.strip.listeners.add(listener);
    return () => stores.strip.listeners.delete(listener);
  },
}));
vi.mock("@/lib/form-factor", () => ({
  getTabRailSnapshot: () => stores.layout.wide,
  subscribeFormFactor: (listener: () => void) => {
    stores.layout.listeners.add(listener);
    return () => stores.layout.listeners.delete(listener);
  },
}));

import { useTabRail } from "./useTabRail";

function notify(listeners: Set<() => void>): void {
  act(() => listeners.forEach((listener) => listener()));
}

describe("useTabRail", () => {
  it("is the bottom bar, then the layout's rail on the right, then the system's strip", () => {
    const { result, unmount } = renderHook(() => useTabRail());
    expect(result.current).toBeNull();

    stores.layout.wide = true;
    notify(stores.layout.listeners);
    expect(result.current).toBe("right");

    // Folded on its side, the strip on the left: the rail follows it.
    stores.strip.side = "left";
    notify(stores.strip.listeners);
    expect(result.current).toBe("left");

    stores.strip.side = null;
    notify(stores.strip.listeners);
    stores.layout.wide = false;
    notify(stores.layout.listeners);
    expect(result.current).toBeNull();

    unmount();
    expect(stores.strip.listeners.size).toBe(0);
    expect(stores.layout.listeners.size).toBe(0);
  });
});
