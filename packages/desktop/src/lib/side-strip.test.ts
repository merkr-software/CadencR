// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

const layout = vi.hoisted(() => ({
  phone: true,
  docked: false,
  listeners: new Set<() => void>(),
}));

vi.mock("./form-factor", () => ({
  getPhoneShellSnapshot: () => layout.phone,
  getDockedSidebarSnapshot: () => layout.docked,
  subscribeFormFactor: (listener: () => void) => {
    layout.listeners.add(listener);
    return () => layout.listeners.delete(listener);
  },
}));

import {
  getSideStripSnapshot,
  installSideStrip,
  resolveSideStrip,
  stripSide,
  subscribeSideStrip,
} from "./side-strip";

const PHONE = { phone: true, docked: false };

describe("stripSide", () => {
  it.each<[string, number, number, "left" | "right" | null]>([
    ["Duo folded, portrait", 0, 84, "right"],
    ["Duo folded on its side, camera on the left", 84, 0, "left"],
    ["Duo unfolded on its side", 0, 84, "right"],
    ["Duo unfolded, portrait", 0, 0, null],
    // A phone on its side mirrors its notch's inset: no strip.
    ["iPhone landscape", 62, 62, null],
    ["a thin inset", 0, 20, null],
  ])("%s → %s", (_name, left, right, expected) => {
    expect(stripSide(left, right)).toBe(expected);
  });
});

describe("resolveSideStrip", () => {
  it("puts the rail in the strip beside the conversation", () => {
    expect(resolveSideStrip("right", PHONE)).toBe("right");
    expect(resolveSideStrip("left", PHONE)).toBe("left");
    // Docked: on the right of the sidebar.
    expect(resolveSideStrip("right", { ...PHONE, docked: true })).toBe("right");
  });

  it("leaves a left strip to the docked sidebar", () => {
    expect(resolveSideStrip("left", { ...PHONE, docked: true })).toBeNull();
  });

  it("does nothing without a strip or in the desktop layout", () => {
    expect(resolveSideStrip(null, PHONE)).toBeNull();
    expect(resolveSideStrip("right", { ...PHONE, phone: false })).toBeNull();
  });
});

describe("installSideStrip", () => {
  let detach: (() => void) | undefined;
  afterEach(() => {
    detach?.();
    detach = undefined;
    vi.restoreAllMocks();
    Reflect.deleteProperty(window, "CSS");
    Object.assign(layout, { phone: true, docked: false });
  });

  /** iOS WebKit or not, as `CSS.supports("-webkit-touch-callout", "none")` tells. */
  function mockIos(ios: boolean): void {
    // happy-dom hands out a new `CSS` object on each read: replace the property.
    Object.defineProperty(window, "CSS", {
      configurable: true,
      value: { supports: () => ios },
    });
  }

  function mockInsets(insets: { left: number; right: number }): void {
    const real = window.getComputedStyle.bind(window);
    vi.spyOn(window, "getComputedStyle").mockImplementation((element) => {
      const style = real(element);
      if (element instanceof HTMLElement && element.hasAttribute("data-inset-probe")) {
        // Live, like a real computed style.
        return {
          get paddingLeft() {
            return `${insets.left}px`;
          },
          get paddingRight() {
            return `${insets.right}px`;
          },
        } as CSSStyleDeclaration;
      }
      return style;
    });
  }

  it("writes the strip on <html> and follows folds and the layout", () => {
    mockIos(true);
    const insets = { left: 0, right: 84 };
    mockInsets(insets);
    const onChange = vi.fn();
    const unsubscribe = subscribeSideStrip(onChange);
    detach = installSideStrip();
    const { dataset } = document.documentElement;
    expect(dataset.sideStrip).toBe("right");
    expect(getSideStripSnapshot()).toBe("right");

    // Unfolded, portrait: no strip any more.
    insets.right = 0;
    window.dispatchEvent(new Event("resize"));
    expect(dataset.sideStrip).toBeUndefined();
    expect(onChange).toHaveBeenCalledTimes(2);

    // On its side, the other way, with the sidebar docked: the sidebar keeps off it.
    insets.left = 84;
    layout.docked = true;
    for (const listener of layout.listeners) listener();
    expect(dataset.sideStrip).toBeUndefined();
    expect(onChange).toHaveBeenCalledTimes(2);

    unsubscribe();
  });

  it("picks up insets that change after the last event", () => {
    vi.useFakeTimers();
    try {
      mockIos(true);
      const insets = { left: 0, right: 0 };
      mockInsets(insets);
      detach = installSideStrip();
      // Folding: the resize lands before iOS moves the status bar to the side.
      window.dispatchEvent(new Event("resize"));
      insets.right = 84;
      vi.advanceTimersByTime(100);
      expect(document.documentElement.dataset.sideStrip).toBe("right");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does nothing outside iOS", () => {
    mockIos(false);
    mockInsets({ left: 0, right: 84 });
    detach = installSideStrip();
    expect(document.documentElement.dataset.sideStrip).toBeUndefined();
    expect(document.querySelector("[data-inset-probe]")).toBeNull();
  });
});
