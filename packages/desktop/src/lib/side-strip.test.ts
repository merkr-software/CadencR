// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

const layout = vi.hoisted(() => ({
  phone: true,
  docked: false,
  twoPanes: false,
  listeners: new Set<() => void>(),
}));

vi.mock("./form-factor", () => ({
  getPhoneShellSnapshot: () => layout.phone,
  getDockedSidebarSnapshot: () => layout.docked,
  getTwoPanesSnapshot: () => layout.twoPanes,
  subscribeFormFactor: (listener: () => void) => {
    layout.listeners.add(listener);
    return () => layout.listeners.delete(listener);
  },
}));

import {
  getStripRailSnapshot,
  installSideStrip,
  resolveSideStrip,
  stripSide,
  subscribeSideStrip,
} from "./side-strip";

const PHONE = { phone: true, docked: false, twoPanes: false };

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
    expect(resolveSideStrip("right", PHONE)).toEqual({ strip: "right", rail: "right" });
    expect(resolveSideStrip("left", PHONE)).toEqual({ strip: "left", rail: "left" });
    // Docked on the right of the sidebar, two panes on the right of the inbox.
    expect(resolveSideStrip("right", { ...PHONE, docked: true })).toEqual({
      strip: "right",
      rail: "right",
    });
    expect(resolveSideStrip("right", { ...PHONE, twoPanes: true })).toEqual({
      strip: "right",
      rail: "right",
    });
  });

  it("leaves a left strip to the sidebar or the inbox beside it", () => {
    expect(resolveSideStrip("left", { ...PHONE, docked: true })).toEqual({
      strip: null,
      rail: null,
    });
    expect(resolveSideStrip("left", { ...PHONE, twoPanes: true })).toEqual({
      strip: "left",
      rail: null,
    });
  });

  it("does nothing without a strip or in the desktop layout", () => {
    expect(resolveSideStrip(null, PHONE)).toEqual({ strip: null, rail: null });
    expect(resolveSideStrip("right", { ...PHONE, phone: false })).toEqual({
      strip: null,
      rail: null,
    });
  });
});

describe("installSideStrip", () => {
  let detach: (() => void) | undefined;
  afterEach(() => {
    detach?.();
    detach = undefined;
    vi.restoreAllMocks();
    Reflect.deleteProperty(window, "CSS");
    Object.assign(layout, { phone: true, docked: false, twoPanes: false });
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

  it("writes the strip and the rail on <html> and follows folds and the layout", () => {
    mockIos(true);
    const insets = { left: 0, right: 84 };
    mockInsets(insets);
    const onChange = vi.fn();
    const unsubscribe = subscribeSideStrip(onChange);
    detach = installSideStrip();
    const { dataset } = document.documentElement;
    expect(dataset.sideStrip).toBe("right");
    expect(dataset.stripRail).toBe("right");
    expect(getStripRailSnapshot()).toBe("right");

    // Unfolded, portrait: no strip any more.
    insets.right = 0;
    window.dispatchEvent(new Event("resize"));
    expect(dataset.sideStrip).toBeUndefined();
    expect(dataset.stripRail).toBeUndefined();
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
      expect(document.documentElement.dataset.stripRail).toBe("right");
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
