import { describe, expect, it, vi } from "vitest";
import { attachTouchScroll } from "./terminal-touch-scroll";
import type { TerminalEngine } from "./terminal-engine";

function touch(surface: HTMLElement, type: string, positions: number[]) {
  const event = new Event(type, { cancelable: true });
  Object.defineProperty(event, "touches", {
    value: positions.map((clientY, identifier) => ({ clientY, identifier })),
  });
  surface.dispatchEvent(event);
  return event;
}

describe("terminal touch scrolling", () => {
  function setup() {
    const surface = document.createElement("div");
    surface.style.lineHeight = "10px";
    Object.defineProperty(surface, "clientHeight", { value: 240 });
    const scrollLines = vi.fn();
    const dispose = attachTouchScroll(surface, { scrollLines } as unknown as TerminalEngine);
    return { surface, scrollLines, dispose };
  }

  it("accumulates sub-row motion while preventing outer-page scroll", () => {
    const { surface, scrollLines, dispose } = setup();
    touch(surface, "touchstart", [100]);
    expect(touch(surface, "touchmove", [105]).defaultPrevented).toBe(true);
    expect(scrollLines).not.toHaveBeenCalled();
    touch(surface, "touchmove", [111]);
    expect(scrollLines).toHaveBeenCalledWith(-1);
    dispose();
  });

  it("does not resume stale deltas after multitouch or cancellation", () => {
    const { surface, scrollLines, dispose } = setup();
    touch(surface, "touchstart", [100]);
    touch(surface, "touchstart", [100, 200]);
    touch(surface, "touchmove", [220]);
    expect(scrollLines).not.toHaveBeenCalled();
    touch(surface, "touchstart", [100]);
    touch(surface, "touchcancel", []);
    touch(surface, "touchmove", [220]);
    expect(scrollLines).not.toHaveBeenCalled();
    dispose();
  });

  it("removes every gesture listener on disposal", () => {
    const { surface, scrollLines, dispose } = setup();
    const remove = vi.spyOn(surface, "removeEventListener");
    dispose();
    expect(remove.mock.calls.map(([name]) => name)).toEqual([
      "touchstart",
      "touchmove",
      "touchend",
      "touchcancel",
    ]);
    touch(surface, "touchstart", [100]);
    touch(surface, "touchmove", [220]);
    expect(scrollLines).not.toHaveBeenCalled();
  });
});
