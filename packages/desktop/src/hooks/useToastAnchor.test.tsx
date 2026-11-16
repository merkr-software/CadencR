import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import { useToastAnchorStore } from "@/stores/toast-anchor-store";
import { useToastAnchor } from "./useToastAnchor";

const resizeCallbacks: Array<() => void> = [];
class CapturingResizeObserver {
  constructor(callback: () => void) {
    resizeCallbacks.push(callback);
  }
  observe(): void {}
  disconnect(): void {}
}

function boxed<T extends HTMLElement>(element: T, box: Partial<DOMRect>): T {
  element.getBoundingClientRect = () => ({ ...box }) as DOMRect;
  return element;
}

/** aside[data-app-sidebar] > footer > settings row, each with a mutable box. */
function sidebar() {
  const sidebarBox = { width: 260 };
  const footerBox = { top: 750 };
  const rowBox = { left: 13, width: 234 };
  const aside = boxed(document.createElement("aside"), sidebarBox);
  aside.setAttribute("data-app-sidebar", "");
  const footer = boxed(document.createElement("div"), footerBox);
  const row = boxed(document.createElement("div"), rowBox);
  aside.appendChild(footer).appendChild(row);
  return { ref: { current: row }, aside, sidebarBox, footerBox, rowBox };
}

const anchor = () => useToastAnchorStore.getState().anchor;

describe("useToastAnchor", () => {
  const originalResizeObserver = window.ResizeObserver;
  beforeEach(() => {
    resizeCallbacks.length = 0;
    window.ResizeObserver = CapturingResizeObserver as unknown as typeof ResizeObserver;
    useToastAnchorStore.setState({ anchor: null });
  });
  afterEach(() => {
    window.ResizeObserver = originalResizeObserver;
  });

  it("stacks toasts above the footer, as wide as the settings row", () => {
    const { ref, footerBox, rowBox } = sidebar();
    const { unmount } = renderHook(() => useToastAnchor(ref, true));
    expect(anchor()).toEqual({ bottom: window.innerHeight - 750 + 4, left: 13, width: 234 });

    // An update pill grows the footer and a drag widens the sidebar.
    footerBox.top = 710;
    rowBox.width = 300;
    resizeCallbacks[0]();
    expect(anchor()).toEqual({ bottom: window.innerHeight - 710 + 4, left: 13, width: 300 });

    unmount();
    expect(anchor()).toBeNull();
  });

  it("publishes nothing while the sidebar is narrower than its minimum", () => {
    const { ref, sidebarBox } = sidebar();
    sidebarBox.width = 40;
    renderHook(() => useToastAnchor(ref, true));
    expect(anchor()).toBeNull();

    sidebarBox.width = 260;
    resizeCallbacks[0]();
    expect(anchor()).not.toBeNull();
  });

  it("re-measures when the sidebar's own slide-in settles, not on row transitions", () => {
    const { ref, aside, rowBox } = sidebar();
    renderHook(() => useToastAnchor(ref, true));
    rowBox.left = 21;

    ref.current.dispatchEvent(
      Object.assign(new Event("transitionend", { bubbles: true }), { propertyName: "transform" }),
    );
    expect(anchor()?.left).toBe(13);

    aside.dispatchEvent(Object.assign(new Event("transitionend"), { propertyName: "transform" }));
    expect(anchor()?.left).toBe(21);
  });

  it("clears the anchor once disabled", () => {
    const { ref } = sidebar();
    const { rerender } = renderHook(({ enabled }) => useToastAnchor(ref, enabled), {
      initialProps: { enabled: true },
    });
    expect(anchor()).not.toBeNull();
    rerender({ enabled: false });
    expect(anchor()).toBeNull();
  });
});
