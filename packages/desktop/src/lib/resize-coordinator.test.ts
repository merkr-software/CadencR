// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isResizing,
  popResize,
  pushResize,
  registerHandle,
  subscribeResize,
  unregisterHandle,
} from "./resize-coordinator";

interface FakeRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

function makeHandle(orientation: "vertical" | "horizontal", rect: FakeRect): HTMLElement {
  const el = document.createElement("div");
  el.setAttribute("data-slot", "resizable-handle");
  el.setAttribute("aria-orientation", orientation);
  el.getBoundingClientRect = () =>
    ({
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      x: rect.left,
      y: rect.top,
      width: rect.right - rect.left,
      height: rect.bottom - rect.top,
      toJSON: () => rect,
    }) as DOMRect;
  document.body.appendChild(el);
  return el;
}

function fireDocPointerDown(x: number, y: number): void {
  document.dispatchEvent(
    new PointerEvent("pointerdown", {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
      pointerType: "mouse",
      button: 0,
      isPrimary: true,
    }),
  );
}

afterEach(() => {
  // Drain any leftover refcount and listeners from a misbehaving test.
  while (isResizing()) popResize();
  document.body.innerHTML = "";
  // Fire a pointerup in case a test left window listeners armed.
  window.dispatchEvent(new PointerEvent("pointerup"));
});

describe("resize-coordinator notify semantics", () => {
  it("fires notify(true) on every push, even when already active", () => {
    const listener = vi.fn();
    const unsub = subscribeResize(listener);

    pushResize();
    pushResize();
    pushResize();

    // All three pushes notify(true) — drift recovery for missed pointerup.
    expect(listener.mock.calls).toEqual([[true], [true], [true]]);
    unsub();
    while (isResizing()) popResize();
  });

  it("only fires notify(false) when the refcount returns to 0", () => {
    const listener = vi.fn();
    const unsub = subscribeResize(listener);

    pushResize();
    pushResize();
    listener.mockClear();
    popResize(); // count: 2 → 1
    expect(listener).not.toHaveBeenCalled();
    popResize(); // count: 1 → 0
    expect(listener).toHaveBeenCalledExactlyOnceWith(false);
    unsub();
  });

  it("popResize is a no-op when no drag is active", () => {
    const listener = vi.fn();
    const unsub = subscribeResize(listener);
    popResize();
    popResize();
    expect(listener).not.toHaveBeenCalled();
    unsub();
  });
});

describe("resize-coordinator handle registry + document pointerdown", () => {
  it("treats clicks within HIT_TOLERANCE_PX of a registered handle as a drag start", () => {
    // Vertical handle at x=100..101 (1 px line), full-height.
    const handle = makeHandle("vertical", { left: 100, top: 0, right: 101, bottom: 800 });
    registerHandle(handle);
    const listener = vi.fn();
    const unsub = subscribeResize(listener);

    // 4 px LEFT of the line — inside the 8 px tolerance window.
    fireDocPointerDown(96, 400);
    expect(listener).toHaveBeenCalledWith(true);

    // Releasing via pointerup clears the global state.
    window.dispatchEvent(new PointerEvent("pointerup"));
    expect(listener).toHaveBeenLastCalledWith(false);

    unsub();
    unregisterHandle(handle);
  });

  it("ignores clicks outside the tolerance window", () => {
    const handle = makeHandle("vertical", { left: 100, top: 0, right: 101, bottom: 800 });
    registerHandle(handle);
    const listener = vi.fn();
    const unsub = subscribeResize(listener);

    // 50 px away from the line — well outside the 8 px tolerance.
    fireDocPointerDown(50, 400);
    expect(listener).not.toHaveBeenCalled();

    unsub();
    unregisterHandle(handle);
  });

  it("ignores clicks on the line but outside the handle's vertical extent", () => {
    // Handle that only spans y=100..200 — clicks above or below should miss.
    const handle = makeHandle("vertical", { left: 100, top: 100, right: 101, bottom: 200 });
    registerHandle(handle);
    const listener = vi.fn();
    const unsub = subscribeResize(listener);

    fireDocPointerDown(100, 50); // above the handle
    fireDocPointerDown(100, 250); // below the handle
    expect(listener).not.toHaveBeenCalled();

    unsub();
    unregisterHandle(handle);
  });

  it("releases the global state when the dragged handle unmounts mid-drag", () => {
    const handle = makeHandle("vertical", { left: 100, top: 0, right: 101, bottom: 800 });
    registerHandle(handle);
    const listener = vi.fn();
    const unsub = subscribeResize(listener);

    fireDocPointerDown(100, 400);
    expect(isResizing()).toBe(true);

    // Mid-drag: handle gets unmounted (route swap, layout change, …).
    // Without the fix, the window pointerup listener would leak and the
    // refcount would stay at 1 forever.
    unregisterHandle(handle);

    expect(isResizing()).toBe(false);
    expect(listener).toHaveBeenLastCalledWith(false);

    unsub();
  });

  it("uninstalls the document listener when the last handle unregisters", () => {
    const handle = makeHandle("vertical", { left: 100, top: 0, right: 101, bottom: 800 });
    registerHandle(handle);
    unregisterHandle(handle);

    const listener = vi.fn();
    const unsub = subscribeResize(listener);

    // No handles registered: pointerdowns should not fire pushResize anymore.
    fireDocPointerDown(100, 400);
    expect(listener).not.toHaveBeenCalled();

    unsub();
  });

  it("treats clicks within HIT_TOLERANCE_PX of a horizontal handle as a drag start", () => {
    // Horizontal handle at y=400..401 (1 px line), full-width.
    const handle = makeHandle("horizontal", { left: 0, top: 400, right: 1200, bottom: 401 });
    registerHandle(handle);
    const listener = vi.fn();
    const unsub = subscribeResize(listener);

    // 6 px BELOW the line — inside the 8 px tolerance window.
    fireDocPointerDown(600, 406);
    expect(listener).toHaveBeenCalledWith(true);

    // Releasing via pointerup clears the global state.
    window.dispatchEvent(new PointerEvent("pointerup"));
    expect(listener).toHaveBeenLastCalledWith(false);

    unsub();
    unregisterHandle(handle);
  });

  it("ignores clicks outside the tolerance window on a horizontal handle", () => {
    const handle = makeHandle("horizontal", { left: 0, top: 400, right: 1200, bottom: 401 });
    registerHandle(handle);
    const listener = vi.fn();
    const unsub = subscribeResize(listener);

    // 50 px away — well outside the 8 px tolerance.
    fireDocPointerDown(600, 450);
    expect(listener).not.toHaveBeenCalled();

    unsub();
    unregisterHandle(handle);
  });

  it("treats clicks within HIT_TOLERANCE_PX of a horizontal handle's X bounds as a drag start", () => {
    // Bounded-width handle so X-axis tolerance can be exercised independently of Y.
    const handle = makeHandle("horizontal", { left: 400, top: 400, right: 800, bottom: 401 });
    registerHandle(handle);
    const listener = vi.fn();
    const unsub = subscribeResize(listener);

    // On the line (Y inside), 6 px right of `right` — inside the 8 px X tolerance.
    fireDocPointerDown(806, 400);
    expect(listener).toHaveBeenCalledWith(true);

    window.dispatchEvent(new PointerEvent("pointerup"));
    expect(listener).toHaveBeenLastCalledWith(false);

    // Same, 6 px left of `left` — the tolerance is symmetric.
    fireDocPointerDown(394, 400);
    expect(listener).toHaveBeenLastCalledWith(true);

    window.dispatchEvent(new PointerEvent("pointerup"));
    expect(listener).toHaveBeenLastCalledWith(false);

    unsub();
    unregisterHandle(handle);
  });

  it("ignores clicks outside the X tolerance window on a horizontal handle", () => {
    const handle = makeHandle("horizontal", { left: 400, top: 400, right: 800, bottom: 401 });
    registerHandle(handle);
    const listener = vi.fn();
    const unsub = subscribeResize(listener);

    // On the line (Y inside), 50 px right of `right` — well outside the 8 px X tolerance.
    fireDocPointerDown(850, 400);
    expect(listener).not.toHaveBeenCalled();

    // Same on the other side, 50 px left of `left`.
    fireDocPointerDown(350, 400);
    expect(listener).not.toHaveBeenCalled();

    unsub();
    unregisterHandle(handle);
  });
});
