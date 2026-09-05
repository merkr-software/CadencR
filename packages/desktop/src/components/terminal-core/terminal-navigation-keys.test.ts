import { describe, expect, it, vi } from "vitest";
import { attachNavigationKeys } from "./terminal-navigation-keys";

function key(surface: HTMLElement, key: string, options: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...options });
  surface.dispatchEvent(event);
  return event;
}

describe("terminal navigation keys", () => {
  it("sends Cmd+arrows once and removes its listener", () => {
    const surface = document.createElement("div");
    const write = vi.fn();
    const dispose = attachNavigationKeys(surface, { isActive: () => true, write });
    expect(key(surface, "ArrowLeft", { metaKey: true }).defaultPrevented).toBe(true);
    key(surface, "ArrowRight", { metaKey: true });
    expect(write.mock.calls).toEqual([["\x01"], ["\x05"]]);
    dispose();
    key(surface, "ArrowLeft", { metaKey: true });
    expect(write).toHaveBeenCalledTimes(2);
  });

  it("leaves composition, consumed events, control keys and inactive sessions alone", () => {
    const surface = document.createElement("div");
    const write = vi.fn();
    let active = true;
    const dispose = attachNavigationKeys(surface, { isActive: () => active, write });
    key(surface, "ArrowLeft", { metaKey: true, isComposing: true });
    key(surface, "c", { ctrlKey: true });
    key(surface, "ArrowLeft", { altKey: true, shiftKey: true });
    const consumed = new KeyboardEvent("keydown", {
      key: "ArrowLeft",
      metaKey: true,
      cancelable: true,
    });
    consumed.preventDefault();
    surface.dispatchEvent(consumed);
    active = false;
    key(surface, "ArrowRight", { metaKey: true });
    expect(write).not.toHaveBeenCalled();
    dispose();
  });

  it("restores Alt+arrow word navigation without reaching the engine's key handler", () => {
    const surface = document.createElement("div");
    const engine = vi.fn();
    surface.addEventListener("keydown", engine);
    const write = vi.fn();
    const dispose = attachNavigationKeys(surface, { isActive: () => true, write });
    key(surface, "ArrowLeft", { altKey: true });
    key(surface, "ArrowRight", { altKey: true });
    expect(write.mock.calls).toEqual([["\x1bb"], ["\x1bf"]]);
    expect(engine).not.toHaveBeenCalled();
    dispose();
    key(surface, "ArrowLeft", { altKey: true });
    expect(engine).toHaveBeenCalledOnce();
  });
});
