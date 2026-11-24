// @vitest-environment happy-dom
import { act, renderHook } from "@testing-library/react";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// A fake viewport answering the store's real media queries, so every case also
// pins the query strings themselves.

interface Viewport {
  width: number;
  height: number;
  coarsePointer: boolean;
}

const viewport = vi.hoisted(() => ({
  state: { width: 1280, height: 800, coarsePointer: false } as Viewport,
  // One entry per MediaQueryList listener (the store adds the same function to each).
  listeners: [] as (() => void)[],
  // The store's viewport reader (`watchViewport`), the current module copy's only.
  readers: [] as (() => void)[],
}));

vi.mock("./viewport-settle", () => ({
  watchViewport: (read: () => void) => {
    viewport.readers.push(read);
    read();
    return () => viewport.readers.splice(viewport.readers.indexOf(read), 1);
  },
}));

function evaluate(query: string): boolean {
  const maxWidth = /^\(max-width: (\d+)px\)$/.exec(query);
  if (maxWidth) return viewport.state.width <= Number(maxWidth[1]);
  const minWidth = /^\(min-width: (\d+)px\)$/.exec(query);
  if (minWidth) return viewport.state.width >= Number(minWidth[1]);
  const minHeight = /^\(min-height: (\d+)px\)$/.exec(query);
  if (minHeight) return viewport.state.height >= Number(minHeight[1]);
  if (query === "(pointer: coarse)") return viewport.state.coarsePointer;
  throw new Error(`unexpected media query: ${query}`);
}

function setViewport(next: Viewport): void {
  viewport.state = { ...next };
  act(() => viewport.listeners.forEach((listener) => listener()));
}

/** A viewport change no media query sees: only the viewport watcher reads it. */
function resizeWithinQueries(next: Viewport): void {
  viewport.state = { ...next };
  act(() => viewport.readers.forEach((read) => read()));
}

const FINE = { coarsePointer: false };
const TOUCH = { coarsePointer: true };

let originalMatchMedia: typeof window.matchMedia;

beforeAll(() => {
  originalMatchMedia = window.matchMedia;
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    get: () => viewport.state.width,
  });
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
  Reflect.deleteProperty(window, "innerWidth");
});

beforeEach(() => {
  vi.resetModules();
  viewport.listeners.length = 0;
  viewport.readers.length = 0;
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

describe("panes by device", () => {
  it.each<[string, Viewport, boolean]>([
    ["Duo folded", { width: 382, height: 580, ...TOUCH }, false],
    ["Duo unfolded", { width: 669, height: 825, ...TOUCH }, true],
    // Measured in the iPhone Duo's home-screen app (iOS 27.1), whose `screen` is the outer one.
    ["Duo unfolded, installed app", { width: 669, height: 930, ...TOUCH }, true],
    // Wide enough to dock the sidebar instead.
    ["Duo unfolded, landscape", { width: 951, height: 543, ...TOUCH }, false],
    ["iPhone portrait", { width: 402, height: 874, ...TOUCH }, false],
    // Wide enough, but too short to leave room for a transcript.
    ["iPhone landscape", { width: 874, height: 370, ...TOUCH }, false],
    ["iPhone landscape, keyboard open", { width: 874, height: 180, ...TOUCH }, false],
    ["iPad mini portrait", { width: 744, height: 1133, ...TOUCH }, true],
    ["just under the threshold", { width: 599, height: 900, ...TOUCH }, false],
    ["wide viewport, just too short", { width: 800, height: 599, ...TOUCH }, false],
    ["iPad landscape (desktop layout)", { width: 1180, height: 820, ...TOUCH }, false],
    ["desktop window, narrow (mouse)", { width: 700, height: 900, ...FINE }, false],
    ["desktop window, wide (mouse)", { width: 1440, height: 900, ...FINE }, false],
  ])("%s → two panes: %s", async (_name, device, expected) => {
    viewport.state = device;
    const { getTwoPanesSnapshot } = await import("./form-factor");
    expect(getTwoPanesSnapshot()).toBe(expected);
  });

  it("writes data-panes and follows folding, without notifying when nothing changed", async () => {
    viewport.state = { width: 382, height: 580, ...TOUCH };
    const { getDockedSidebarSnapshot, installShellAttribute, subscribeFormFactor } =
      await import("./form-factor");
    installShellAttribute();
    const onChange = vi.fn();
    subscribeFormFactor(onChange);
    expect(document.documentElement.dataset.panes).toBe("1");

    setViewport({ width: 669, height: 825, ...TOUCH });
    expect(document.documentElement.dataset.panes).toBe("2");
    expect(document.documentElement.dataset.shell).toBe("phone");
    expect(onChange).toHaveBeenCalledTimes(1);

    // On its side: the docked sidebar takes the inbox pane's place.
    setViewport({ width: 951, height: 543, ...TOUCH });
    expect(document.documentElement.dataset.panes).toBe("1");
    expect(getDockedSidebarSnapshot()).toBe(true);
    expect(onChange).toHaveBeenCalledTimes(2);

    setViewport({ width: 382, height: 580, ...TOUCH });
    expect(document.documentElement.dataset.panes).toBe("1");
    expect(getDockedSidebarSnapshot()).toBe(false);
    expect(onChange).toHaveBeenCalledTimes(3);
  });

  it("keeps two panes while a keyboard shortens the viewport, not after a fold", async () => {
    viewport.state = { width: 669, height: 930, ...TOUCH };
    const { installShellAttribute, subscribeFormFactor } = await import("./form-factor");
    installShellAttribute();
    const onChange = vi.fn();
    subscribeFormFactor(onChange);
    expect(document.documentElement.dataset.panes).toBe("2");

    // The keyboard: a field focused, shorter at the same width.
    const field = document.createElement("textarea");
    document.body.append(field);
    field.focus();
    setViewport({ width: 669, height: 520, ...TOUCH });
    expect(document.documentElement.dataset.panes).toBe("2");
    setViewport({ width: 669, height: 930, ...TOUCH });
    expect(onChange).not.toHaveBeenCalled();

    // Turned on its side with less room than that: the width changes too.
    setViewport({ width: 700, height: 520, ...TOUCH });
    expect(document.documentElement.dataset.panes).toBe("1");
    expect(onChange).toHaveBeenCalledTimes(1);
    field.remove();
  });

  it("drops two panes when a fold changes the width without crossing a query", async () => {
    viewport.state = { width: 669, height: 930, ...TOUCH };
    const { installShellAttribute } = await import("./form-factor");
    installShellAttribute();
    // Folded on its side with a field focused: first the height (at the
    // unfolded width, held like a keyboard), then the width, which crosses no query.
    const field = document.createElement("textarea");
    document.body.append(field);
    field.focus();
    setViewport({ width: 669, height: 445, ...TOUCH });
    expect(document.documentElement.dataset.panes).toBe("2");
    resizeWithinQueries({ width: 678, height: 445, ...TOUCH });
    expect(document.documentElement.dataset.panes).toBe("1");
    field.remove();
  });

  it("drops two panes on a rotation that reports its width first", async () => {
    viewport.state = { width: 466, height: 657, ...TOUCH };
    const { installShellAttribute } = await import("./form-factor");
    installShellAttribute();
    // Folded, turned on its side: the new width with the old height, then the height.
    setViewport({ width: 678, height: 657, ...TOUCH });
    expect(document.documentElement.dataset.panes).toBe("2");
    setViewport({ width: 678, height: 445, ...TOUCH });
    expect(document.documentElement.dataset.panes).toBe("1");
  });

  it("keeps one pane on a phone turning on its side and opening its keyboard", async () => {
    viewport.state = { width: 402, height: 874, ...TOUCH };
    const { installShellAttribute, subscribeFormFactor } = await import("./form-factor");
    installShellAttribute();
    const onChange = vi.fn();
    subscribeFormFactor(onChange);

    setViewport({ width: 874, height: 370, ...TOUCH });
    setViewport({ width: 874, height: 180, ...TOUCH });
    expect(document.documentElement.dataset.panes).toBe("1");
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("docked sidebar by device", () => {
  it.each<[string, Viewport, boolean]>([
    ["Duo unfolded, landscape", { width: 951, height: 543, ...TOUCH }, true],
    ["Duo unfolded, portrait", { width: 669, height: 825, ...TOUCH }, false],
    ["Duo folded", { width: 382, height: 580, ...TOUCH }, false],
    ["iPhone landscape", { width: 874, height: 370, ...TOUCH }, false],
    ["iPhone Pro Max landscape", { width: 956, height: 400, ...TOUCH }, true],
    ["just under the threshold", { width: 899, height: 600, ...TOUCH }, false],
    ["iPad mini portrait", { width: 744, height: 1133, ...TOUCH }, false],
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
    expect(viewport.listeners).toHaveLength(6);

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
