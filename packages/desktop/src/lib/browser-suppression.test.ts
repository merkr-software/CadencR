// @vitest-environment happy-dom
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearDesktopBridgeOverrideForTests,
  setDesktopBridgeOverrideForTests,
} from "@/lib/desktop-bridge";
import { useSuppressBrowserView } from "./browser-suppression";

afterEach(() => {
  clearDesktopBridgeOverrideForTests();
});

describe("useSuppressBrowserView", () => {
  it("never suppresses native views for remote overlays, including on cleanup", () => {
    const setBrowserSuppressed = vi.fn(async () => undefined);
    setDesktopBridgeOverrideForTests({ isElectron: false, setBrowserSuppressed });
    const { rerender, unmount } = renderHook(({ active }) => useSuppressBrowserView(active), {
      initialProps: { active: true },
    });
    rerender({ active: false });
    rerender({ active: true });
    unmount();
    expect(setBrowserSuppressed).not.toHaveBeenCalled();
  });

  it("keeps desktop views suppressed until the last overlay closes", async () => {
    const setBrowserSuppressed = vi.fn(async () => undefined);
    setDesktopBridgeOverrideForTests({ isElectron: true, setBrowserSuppressed });
    const first = renderHook(() => useSuppressBrowserView());
    const second = renderHook(() => useSuppressBrowserView());
    await act(async () => first.unmount());
    expect(setBrowserSuppressed).toHaveBeenLastCalledWith(true);
    await act(async () => second.unmount());
    expect(setBrowserSuppressed).toHaveBeenLastCalledWith(false);
  });
});
