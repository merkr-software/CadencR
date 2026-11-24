// @vitest-environment happy-dom
import { act, renderHook } from "@testing-library/react";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// A fake viewport answering the store's real media queries, so every case also
// pins the query strings themselves.

interface Viewport {
  width: number;
  height: number;
  coarsePointer: boolean;
  /** `screen.width × screen.height`; the viewport's size when omitted. */
  screen?: readonly [number, number];
}

const viewport = vi.hoisted(() => ({
  state: { width: 1280, height: 800, coarsePointer: false } as Viewport,
  // One entry per MediaQueryList listener (the store adds the same function to each).
  listeners: [] as (() => void)[],
}));

function evaluate(query: string): boolean {
  const maxWidth = /^\(max-width: (\d+)px\)$/.exec(query);
  if (maxWidth) return viewport.state.width <= Number(maxWidth[1]);
  const minWidth = /^\(min-width: (\d+)px\)$/.exec(query);
  if (minWidth) return viewport.state.width >= Number(minWidth[1]);
  if (query === "(pointer: coarse)") return viewport.state.coarsePointer;
  throw new Error(`unexpected media query: ${query}`);
}

function setViewport(next: Viewport): void {
  viewport.state = { ...next };
  act(() => viewport.listeners.forEach((listener) => listener()));
}

const FINE = { coarsePointer: false };
const TOUCH = { coarsePointer: true };

let originalMatchMedia: typeof window.matchMedia;

function screenSide(index: 0 | 1): number {
  const { screen, width, height } = viewport.state;
  return screen ? screen[index] : index === 0 ? width : height;
}

beforeAll(() => {
  originalMatchMedia = window.matchMedia;
  Object.defineProperty(window.screen, "width", { configurable: true, get: () => screenSide(0) });
  Object.defineProperty(window.screen, "height", { configurable: true, get: () => screenSide(1) });
  window.matchMedia = (query: string) =>
    ({
      media: query,
      get matches() {
        return evaluate(query);
      },
      addEventListener: (_: string, listener: () => void) => viewport.listeners.push(listener),
      removeEventListener: (_: string, listener: () => void) =>
        viewport.listeners.splice(viewport.listeners.indexOf(listener), 1),
    }) as unknown as MediaQueryList;
});

afterAll(() => {
  window.matchMedia = originalMatchMedia;
  Reflect.deleteProperty(window.screen, "width");
  Reflect.deleteProperty(window.screen, "height");
});

beforeEach(() => {
  vi.resetModules();
  viewport.listeners.length = 0;
  viewport.state = { width: 1280, height: 800, ...FINE };
  delete document.documentElement.dataset.shell;
  delete document.documentElement.dataset.panes;
});

describe("phone layout by device", () => {
  it.each<[string, Viewport, boolean]>([
    ["desktop window, narrow", { width: 700, height: 900, ...FINE }, true],
    ["desktop window, mid", { width: 900, height: 900, ...FINE }, false],
    ["desktop window, wide", { width: 1440, height: 900, ...FINE }, false],
    ["desktop window, short", { width: 1280, height: 400, ...FINE }, false],
    ["iPhone portrait", { width: 402, height: 874, ...TOUCH }, true],
    ["iPhone landscape", { width: 874, height: 370, ...TOUCH }, true],
    ["Duo folded", { width: 382, height: 580, ...TOUCH }, true],
    ["Duo unfolded", { width: 669, height: 825, ...TOUCH }, true],
    ["Duo unfolded, landscape", { width: 951, height: 543, ...TOUCH }, true],
    ["iPad mini portrait", { width: 744, height: 1133, ...TOUCH }, true],
    ["iPad Air portrait", { width: 820, height: 1180, ...TOUCH }, true],
    ["iPad Pro 11in portrait", { width: 834, height: 1210, ...TOUCH }, true],
    ["iPad landscape", { width: 1180, height: 820, ...TOUCH }, false],
    ["iPad Pro 13in portrait", { width: 1032, height: 1376, ...TOUCH }, false],
    // The keyboard shrinks the layout viewport (`resizes-content`): the layout
    // must not flip, or the app shell remounts and closes the keyboard.
    ["Android tablet landscape, keyboard open", { width: 1280, height: 420, ...TOUCH }, false],
  ])("%s → phone layout: %s", async (_name, device, expected) => {
    viewport.state = device;
    const { getPhoneShellSnapshot } = await import("./form-factor");
    expect(getPhoneShellSnapshot()).toBe(expected);
  });
});

// The physical screens: iOS reports the portrait screen in either orientation.
const IPHONE_SCREEN = [402, 874] as const;
const DUO_UNFOLDED_SCREEN = [669, 825] as const;

describe("panes by device", () => {
  it.each<[string, Viewport, boolean]>([
    ["Duo folded", { width: 382, height: 580, ...TOUCH, screen: [382, 640] }, false],
    ["Duo unfolded", { width: 669, height: 825, ...TOUCH, screen: DUO_UNFOLDED_SCREEN }, true],
    // Wide enough to dock the sidebar instead.
    ["Duo unfolded, landscape", { width: 951, height: 543, ...TOUCH, screen: [825, 669] }, false],
    ["iPhone portrait", { width: 402, height: 874, ...TOUCH, screen: IPHONE_SCREEN }, false],
    // Wide enough, but the screen's short side leaves no room for a transcript.
    ["iPhone landscape", { width: 874, height: 370, ...TOUCH, screen: IPHONE_SCREEN }, false],
    [
      "iPhone landscape, keyboard open",
      { width: 874, height: 180, ...TOUCH, screen: IPHONE_SCREEN },
      false,
    ],
    ["iPad mini portrait", { width: 744, height: 1133, ...TOUCH, screen: [744, 1133] }, true],
    ["just under the threshold", { width: 599, height: 900, ...TOUCH }, false],
    [
      "wide viewport on a short screen",
      { width: 800, height: 599, ...TOUCH, screen: [800, 599] },
      false,
    ],
    ["iPad landscape (desktop layout)", { width: 1180, height: 820, ...TOUCH }, false],
    ["desktop window, narrow (mouse)", { width: 700, height: 900, ...FINE }, false],
    ["desktop window, wide (mouse)", { width: 1440, height: 900, ...FINE }, false],
  ])("%s → two panes: %s", async (_name, device, expected) => {
    viewport.state = device;
    const { getTwoPanesSnapshot } = await import("./form-factor");
    expect(getTwoPanesSnapshot()).toBe(expected);
  });

  it("writes data-panes and follows folding, without notifying when nothing changed", async () => {
    viewport.state = { width: 382, height: 580, ...TOUCH, screen: [382, 640] };
    const { getDockedSidebarSnapshot, installShellAttribute, subscribeFormFactor } =
      await import("./form-factor");
    installShellAttribute();
    const onChange = vi.fn();
    subscribeFormFactor(onChange);
    expect(document.documentElement.dataset.panes).toBe("1");

    setViewport({ width: 669, height: 825, ...TOUCH, screen: DUO_UNFOLDED_SCREEN });
    expect(document.documentElement.dataset.panes).toBe("2");
    expect(document.documentElement.dataset.shell).toBe("phone");
    expect(onChange).toHaveBeenCalledTimes(1);

    // On its side: the docked sidebar takes the inbox pane's place.
    setViewport({ width: 951, height: 543, ...TOUCH, screen: [825, 669] });
    expect(document.documentElement.dataset.panes).toBe("1");
    expect(getDockedSidebarSnapshot()).toBe(true);
    expect(onChange).toHaveBeenCalledTimes(2);

    setViewport({ width: 382, height: 580, ...TOUCH, screen: [382, 640] });
    expect(document.documentElement.dataset.panes).toBe("1");
    expect(getDockedSidebarSnapshot()).toBe(false);
    expect(onChange).toHaveBeenCalledTimes(3);
  });

  it("keeps one pane on a phone turning on its side and opening its keyboard", async () => {
    viewport.state = { width: 402, height: 874, ...TOUCH, screen: IPHONE_SCREEN };
    const { installShellAttribute, subscribeFormFactor } = await import("./form-factor");
    installShellAttribute();
    const onChange = vi.fn();
    subscribeFormFactor(onChange);

    setViewport({ width: 874, height: 370, ...TOUCH, screen: IPHONE_SCREEN });
    setViewport({ width: 874, height: 180, ...TOUCH, screen: IPHONE_SCREEN });
    expect(document.documentElement.dataset.panes).toBe("1");
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("docked sidebar by device", () => {
  it.each<[string, Viewport, boolean]>([
    ["Duo unfolded, landscape", { width: 951, height: 543, ...TOUCH, screen: [825, 669] }, true],
    [
      "Duo unfolded, portrait",
      { width: 669, height: 825, ...TOUCH, screen: DUO_UNFOLDED_SCREEN },
      false,
    ],
    ["Duo folded", { width: 382, height: 580, ...TOUCH, screen: [382, 640] }, false],
    ["iPhone landscape", { width: 874, height: 370, ...TOUCH, screen: IPHONE_SCREEN }, false],
    ["iPhone Pro Max landscape", { width: 956, height: 400, ...TOUCH, screen: [440, 956] }, true],
    ["just under the threshold", { width: 899, height: 600, ...TOUCH }, false],
    ["iPad mini portrait", { width: 744, height: 1133, ...TOUCH, screen: [744, 1133] }, false],
    ["iPad landscape (desktop layout)", { width: 1180, height: 820, ...TOUCH }, false],
    ["desktop window (mouse)", { width: 950, height: 700, ...FINE }, false],
  ])("%s → docked: %s", async (_name, device, expected) => {
    viewport.state = device;
    const { getDockedSidebarSnapshot } = await import("./form-factor");
    expect(getDockedSidebarSnapshot()).toBe(expected);
  });
});

describe("data-shell", () => {
  it("is written on install and follows rotation and folding", async () => {
    viewport.state = { width: 402, height: 874, ...TOUCH };
    const { installShellAttribute } = await import("./form-factor");
    installShellAttribute();
    expect(document.documentElement.dataset.shell).toBe("phone");

    setViewport({ width: 874, height: 370, ...TOUCH });
    expect(document.documentElement.dataset.shell).toBe("phone");

    setViewport({ width: 1180, height: 820, ...TOUCH });
    expect(document.documentElement.dataset.shell).toBe("desktop");

    setViewport({ width: 820, height: 1180, ...TOUCH });
    expect(document.documentElement.dataset.shell).toBe("phone");

    setViewport({ width: 951, height: 543, ...TOUCH });
    expect(document.documentElement.dataset.shell).toBe("phone");
  });

  it("keeps the width breakpoint on a desktop", async () => {
    const { installShellAttribute } = await import("./form-factor");
    installShellAttribute();
    expect(document.documentElement.dataset.shell).toBe("desktop");

    setViewport({ width: 700, height: 900, ...FINE });
    expect(document.documentElement.dataset.shell).toBe("phone");

    setViewport({ width: 874, height: 370, ...FINE });
    expect(document.documentElement.dataset.shell).toBe("desktop");
  });

  it("stays put on a tablet whose keyboard opens", async () => {
    viewport.state = { width: 1280, height: 800, ...TOUCH };
    const { installShellAttribute } = await import("./form-factor");
    installShellAttribute();
    setViewport({ width: 1280, height: 420, ...TOUCH });
    expect(document.documentElement.dataset.shell).toBe("desktop");
  });

  it("is not written until installed", async () => {
    const { getPhoneShellSnapshot } = await import("./form-factor");
    setViewport({ width: 402, height: 874, ...TOUCH });
    expect(getPhoneShellSnapshot()).toBe(true);
    expect(document.documentElement.dataset.shell).toBeUndefined();
  });
});

describe("store notifications", () => {
  it("fire only when the layout or the primary pointer changes", async () => {
    const { subscribeFormFactor, getCoarsePointerSnapshot } = await import("./form-factor");
    const onChange = vi.fn();
    subscribeFormFactor(onChange);

    setViewport({ width: 1200, height: 700, ...FINE });
    expect(onChange).not.toHaveBeenCalled();

    setViewport({ width: 1200, height: 700, ...TOUCH });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(getCoarsePointerSnapshot()).toBe(true);

    // The phone layout, with the sidebar docked.
    setViewport({ width: 900, height: 700, ...TOUCH });
    expect(onChange).toHaveBeenCalledTimes(2);

    // Still the phone layout, but too narrow to dock the sidebar.
    setViewport({ width: 800, height: 700, ...TOUCH });
    expect(onChange).toHaveBeenCalledTimes(3);

    setViewport({ width: 760, height: 700, ...TOUCH });
    expect(onChange).toHaveBeenCalledTimes(3);
  });
});

describe("useIsMobile", () => {
  it("re-renders only when the layout flips, from one shared set of listeners", async () => {
    const { useIsMobile } = await import("@/hooks/useIsMobile");
    const { useIsTouchDevice } = await import("@/hooks/useIsTouchDevice");
    let renders = 0;
    const first = renderHook(() => {
      renders += 1;
      return useIsMobile();
    });
    const second = renderHook(() => useIsMobile());
    const touch = renderHook(() => useIsTouchDevice());
    expect(first.result.current).toBe(false);
    // One listener per media query, however many consumers subscribe.
    expect(viewport.listeners).toHaveLength(5);

    const before = renders;
    setViewport({ width: 1200, height: 800, ...FINE });
    expect(renders).toBe(before);

    // Only the pointer changes: the touch consumer follows, the layout ones don't.
    setViewport({ width: 1200, height: 800, ...TOUCH });
    expect(touch.result.current).toBe(true);
    expect(renders).toBe(before);

    setViewport({ width: 874, height: 370, ...TOUCH });
    expect(first.result.current).toBe(true);
    expect(second.result.current).toBe(true);
    expect(renders).toBe(before + 1);
  });
});
