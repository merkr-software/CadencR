// @vitest-environment happy-dom
import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAppHotkeys } from "./useAppHotkeys";
import { useGlobalShortcut } from "./useGlobalShortcut";

const platform = vi.hoisted(() => ({ isMac: false }));
vi.mock("@/lib/shortcuts/format", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/shortcuts/format")>()),
  get PLATFORM_IS_MAC() {
    return platform.isMac;
  },
}));

function terminalInput(): HTMLTextAreaElement {
  const zone = document.createElement("div");
  zone.dataset.focusZone = "terminal";
  const input = document.createElement("textarea");
  zone.append(input);
  document.body.append(zone);
  return input;
}

function pressCtrlD(target: EventTarget): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key: "d",
    code: "KeyD",
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(event);
  return event;
}

afterEach(() => {
  document.body.replaceChildren();
  platform.isMac = false;
});

describe("shell control keys in the terminal (non-macOS)", () => {
  it("lets Ctrl+D reach the shell instead of a capture-phase app shortcut", () => {
    const callback = vi.fn();
    renderHook(() => useGlobalShortcut("Control+D", callback));

    const event = pressCtrlD(terminalInput());

    expect(callback).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it("lets Ctrl+D reach the shell without the form-aware engine preventing it", () => {
    const callback = vi.fn();
    renderHook(() =>
      useAppHotkeys("Control+D", callback, {
        enableOnFormTags: true,
        preventDefault: true,
      }),
    );

    const event = pressCtrlD(terminalInput());

    expect(callback).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it("still fires the same chord outside the terminal", () => {
    const callback = vi.fn();
    renderHook(() => useAppHotkeys("Control+D", callback, { preventDefault: true }));

    const event = pressCtrlD(document.body);

    expect(callback).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(true);
  });
});
