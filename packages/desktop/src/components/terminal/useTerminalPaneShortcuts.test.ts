import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useGlobalShortcut } from "@/hooks/useGlobalShortcut";
import { useTerminalCopyPasteShortcuts } from "./useTerminalPaneShortcuts";

vi.mock("@/hooks/useShortcut", () => ({
  useScopedGlobalShortcutById: (
    id: string,
    callback: (event: KeyboardEvent) => void,
    _scope: string,
    options: { enabled: boolean },
  ) => useGlobalShortcut(id === "terminal-copy" ? "Meta+C" : "Meta+V", callback, options),
}));

function key(key: string, options: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", {
    key,
    metaKey: true,
    bubbles: true,
    cancelable: true,
    ...options,
  });
  window.dispatchEvent(event);
  return event;
}

describe("terminal clipboard handlers", () => {
  it("leaves dialog text inputs native but handles the terminal's own input", () => {
    const onCopy = vi.fn();
    const onPaste = vi.fn();
    renderHook(() =>
      useTerminalCopyPasteShortcuts({
        hotkeysEnabled: true,
        resolvedActivePaneId: "pane",
        onCopy,
        onPaste,
      }),
    );
    const input = document.createElement("textarea");
    document.body.appendChild(input);
    const native = new KeyboardEvent("keydown", {
      key: "v",
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    input.dispatchEvent(native);
    expect(native.defaultPrevented).toBe(false);
    expect(onPaste).not.toHaveBeenCalled();
    const zone = document.createElement("div");
    zone.dataset.focusZone = "terminal";
    document.body.appendChild(zone);
    zone.appendChild(input);
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "v", metaKey: true, bubbles: true, cancelable: true }),
    );
    expect(onPaste).toHaveBeenCalledWith("pane");
    zone.remove();
  });

  it("matches labelled keys across layouts and cleans up on unmount", () => {
    const onCopy = vi.fn();
    const onPaste = vi.fn();
    const { unmount } = renderHook(() =>
      useTerminalCopyPasteShortcuts({
        hotkeysEnabled: true,
        resolvedActivePaneId: "pane",
        onCopy,
        onPaste,
      }),
    );
    expect(key("c", { code: "KeyJ" }).defaultPrevented).toBe(true);
    expect(key("v", { code: "KeyK" }).defaultPrevented).toBe(true);
    expect(onCopy).toHaveBeenCalledWith("pane");
    expect(onPaste).toHaveBeenCalledWith("pane");
    unmount();
    key("c");
    expect(onCopy).toHaveBeenCalledOnce();
  });

  it("ignores composition, consumed events and disabled panes", () => {
    const onCopy = vi.fn();
    const onPaste = vi.fn();
    const { rerender } = renderHook(
      (hotkeysEnabled) =>
        useTerminalCopyPasteShortcuts({
          hotkeysEnabled,
          resolvedActivePaneId: "pane",
          onCopy,
          onPaste,
        }),
      { initialProps: true },
    );
    key("c", { isComposing: true });
    key("v", { isComposing: true });
    const consumed = new KeyboardEvent("keydown", { key: "c", metaKey: true, cancelable: true });
    consumed.preventDefault();
    window.dispatchEvent(consumed);
    rerender(false);
    key("c");
    key("v");
    expect(onCopy).not.toHaveBeenCalled();
    expect(onPaste).not.toHaveBeenCalled();
  });
});
