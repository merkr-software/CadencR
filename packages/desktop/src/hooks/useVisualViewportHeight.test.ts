// @vitest-environment happy-dom
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useVisualViewportHeight } from "./useVisualViewportHeight";

interface Viewport {
  resize: (h: number) => void;
  /** Pinch-zoom: the visible viewport shrinks by the zoom factor. */
  zoom: (scale: number) => void;
  /** Pan the layout viewport up (as the browser does to lift a focused input). */
  setPan: (offsetTop: number) => void;
  /** Pan, then fire the standalone `visualViewport` scroll the pan emits. */
  pan: (offsetTop: number) => void;
  scrollTo: ReturnType<typeof vi.spyOn>;
}

/**
 * Minimal stand-in for `window.visualViewport` — jsdom doesn't provide one.
 * Also mocks the window scroll position so we can assert the hook re-pins the
 * document, and mirrors the browser by clearing the pan when `scrollTo` runs.
 */
function installViewport(height: number): Viewport {
  const target = new EventTarget();
  const vv = {
    height,
    offsetTop: 0,
    scale: 1,
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
  };
  Object.defineProperty(window, "visualViewport", { value: vv, configurable: true });

  let scrollY = 0;
  vi.spyOn(window, "scrollX", "get").mockReturnValue(0);
  vi.spyOn(window, "scrollY", "get").mockImplementation(() => scrollY);
  const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation((() => {
    // Real browsers reset both the document scroll and the visual-viewport pan.
    scrollY = 0;
    vv.offsetTop = 0;
  }) as typeof window.scrollTo);

  const setPan = (offsetTop: number): void => {
    scrollY = offsetTop;
    vv.offsetTop = offsetTop;
  };
  return {
    resize: (h: number) => {
      vv.height = h;
      target.dispatchEvent(new Event("resize"));
    },
    zoom: (scale: number) => {
      vv.height = height / scale;
      vv.scale = scale;
      target.dispatchEvent(new Event("resize"));
    },
    setPan,
    pan: (offsetTop: number) => {
      setPan(offsetTop);
      target.dispatchEvent(new Event("scroll"));
    },
    scrollTo,
  };
}

function vh(): string {
  return document.documentElement.style.getPropertyValue("--app-vh");
}

describe("useVisualViewportHeight", () => {
  afterEach(() => {
    document.documentElement.style.removeProperty("--app-vh");
    delete document.documentElement.dataset.keyboardOpen;
    Reflect.deleteProperty(window, "visualViewport");
    vi.restoreAllMocks();
  });

  it("pins --app-vh to the visible height once the keyboard inset clears the threshold", () => {
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(800);
    const { resize } = installViewport(800);

    renderHook(() => useVisualViewportHeight(true));
    // No keyboard yet → no override, CSS unit still owns the height.
    expect(vh()).toBe("");

    act(() => resize(450)); // keyboard opens: 350px inset > threshold
    expect(vh()).toBe("450px");

    act(() => resize(800)); // keyboard closes: override dropped
    expect(vh()).toBe("");
  });

  it("ignores sub-threshold shrink like URL-bar show/hide", () => {
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(800);
    const { resize } = installViewport(800);

    renderHook(() => useVisualViewportHeight(true));
    act(() => resize(720)); // 80px inset < 120px threshold

    expect(vh()).toBe("");
  });

  it("does nothing when disabled or when the API is unavailable", () => {
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(800);
    const { resize } = installViewport(800);

    renderHook(() => useVisualViewportHeight(false));
    act(() => resize(450));
    expect(vh()).toBe("");

    Reflect.deleteProperty(window, "visualViewport");
    expect(() => renderHook(() => useVisualViewportHeight(true))).not.toThrow();
  });

  it("re-pins the document to the top when the keyboard-open viewport pans", () => {
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(800);
    const { resize, pan, scrollTo } = installViewport(800);

    renderHook(() => useVisualViewportHeight(true));
    act(() => resize(450)); // keyboard opens
    expect(vh()).toBe("450px");
    scrollTo.mockClear(); // ignore the harmless reset done while already at top

    act(() => pan(120)); // browser pans the shell up off the screen
    expect(scrollTo).toHaveBeenCalledWith(0, 0);
    expect(window.scrollY).toBe(0);
    expect(vh()).toBe("450px"); // override survives the pan
  });

  it("leaves document scroll alone while the keyboard is closed", () => {
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(800);
    const { pan, scrollTo } = installViewport(800);

    renderHook(() => useVisualViewportHeight(true));
    act(() => pan(120)); // a stray pan with no keyboard open

    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("keeps the override when a resize lands on an already-panned viewport", () => {
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(800);
    const { resize, setPan } = installViewport(800);

    renderHook(() => useVisualViewportHeight(true));
    act(() => resize(450)); // keyboard opens
    expect(vh()).toBe("450px");

    // The browser pans far enough that an offset-based inset (800 - 450 - 250 =
    // 100) would fall under the threshold. The inset is a height difference, so
    // the pan can't drop the override.
    setPan(250);
    act(() => resize(450));
    expect(vh()).toBe("450px");
  });

  it("applies the override on the FIRST focus even if the viewport is already panned", () => {
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(800);
    const { resize, setPan } = installViewport(800);

    renderHook(() => useVisualViewportHeight(true));

    // iOS pans to lift the caret BEFORE the resize tick that reports the
    // keyboard. On that first tick an offset-based inset reads 800 - 450 - 250 =
    // 100, under the 120px threshold, which used to skip the override entirely
    // and leave the shell full-height with only a strip visible: the prompt the
    // user just focused stayed off-screen.
    setPan(250);
    act(() => resize(450));

    expect(vh()).toBe("450px");
  });

  it("detects the keyboard when innerHeight has already shrunk with it (iOS 26)", () => {
    // iOS 26 Safari shrinks `innerHeight` to the visual viewport too, and may do
    // so before the keyboard's resize tick. Measured against `innerHeight` the
    // inset read 0: no override, and the prompt stayed under the keyboard. The
    // root's client height (the initial containing block) does not move.
    let innerHeight = 800;
    vi.spyOn(window, "innerHeight", "get").mockImplementation(() => innerHeight);
    vi.spyOn(document.documentElement, "clientHeight", "get").mockReturnValue(800);
    const { resize } = installViewport(800);

    renderHook(() => useVisualViewportHeight(true));
    innerHeight = 450;
    act(() => resize(450));

    expect(vh()).toBe("450px");
  });

  it("re-pins on the window scroll that carries the caret-reveal pan", () => {
    // The visualViewport scroll trails the pan by ~400ms on iOS; the window
    // scroll arrives at once, so that is the one that must undo it.
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(800);
    const { resize, setPan, scrollTo } = installViewport(800);

    renderHook(() => useVisualViewportHeight(true));
    act(() => resize(450));
    scrollTo.mockClear();

    setPan(350);
    act(() => {
      window.dispatchEvent(new Event("scroll"));
    });
    expect(scrollTo).toHaveBeenCalledWith(0, 0);
    expect(window.scrollY).toBe(0);
  });

  it("does not take a pinch zoom for the keyboard", () => {
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(800);
    const { zoom, setPan, scrollTo } = installViewport(800);

    renderHook(() => useVisualViewportHeight(true));
    act(() => zoom(2)); // the visible viewport is now 400px of the layout
    expect(vh()).toBe("");
    expect(document.documentElement.dataset.keyboardOpen).toBeUndefined();

    // Panning around the zoomed page is left alone.
    setPan(200);
    act(() => {
      window.dispatchEvent(new Event("scroll"));
    });
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("flags the open keyboard on the root so CSS can drop the home-indicator inset", () => {
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(800);
    const { resize } = installViewport(800);
    const root = document.documentElement;

    const { unmount } = renderHook(() => useVisualViewportHeight(true));
    expect(root.dataset.keyboardOpen).toBeUndefined();

    act(() => resize(450));
    expect(root.dataset.keyboardOpen).toBe("");

    act(() => resize(800));
    expect(root.dataset.keyboardOpen).toBeUndefined();

    act(() => resize(450));
    unmount();
    expect(root.dataset.keyboardOpen).toBeUndefined();
  });

  it("clears the override and detaches its listener on unmount", () => {
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(800);
    const { resize, setPan, scrollTo } = installViewport(800);

    const { unmount } = renderHook(() => useVisualViewportHeight(true));
    act(() => resize(450));
    expect(vh()).toBe("450px");

    unmount();
    expect(vh()).toBe(""); // cleanup restores the CSS fallback
    act(() => resize(400)); // stale events no longer mutate the var
    expect(vh()).toBe("");
    scrollTo.mockClear();
    setPan(250);
    act(() => {
      window.dispatchEvent(new Event("scroll"));
    });
    expect(scrollTo).not.toHaveBeenCalled(); // nor re-pin the document
  });
});
