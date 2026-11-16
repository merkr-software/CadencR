// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from "vitest";
import { getActiveFocusZone } from "./focus-zones";

describe("getActiveFocusZone", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("returns null when no focused element has a data-focus-zone", () => {
    const div = document.createElement("div");
    document.body.appendChild(div);
    div.focus();
    // div has no tabIndex so it won't be activeElement in jsdom normally
    // Test that null is returned when activeElement has no zone ancestor
    expect(getActiveFocusZone()).toBeNull();
  });

  it("returns zone name from focused element", () => {
    const div = document.createElement("div");
    div.setAttribute("data-focus-zone", "sidebar");
    div.setAttribute("tabIndex", "0");
    document.body.appendChild(div);
    div.focus();
    expect(getActiveFocusZone()).toBe("sidebar");
  });

  it("returns zone name from ancestor when child is focused", () => {
    const parent = document.createElement("div");
    parent.setAttribute("data-focus-zone", "main");
    const child = document.createElement("input");
    parent.appendChild(child);
    document.body.appendChild(parent);
    child.focus();
    expect(getActiveFocusZone()).toBe("main");
  });

  it("returns innermost (most specific) zone when nested zones exist", () => {
    const outer = document.createElement("div");
    outer.setAttribute("data-focus-zone", "outer");
    const inner = document.createElement("div");
    inner.setAttribute("data-focus-zone", "inner");
    const input = document.createElement("input");
    inner.appendChild(input);
    outer.appendChild(inner);
    document.body.appendChild(outer);
    input.focus();
    expect(getActiveFocusZone()).toBe("inner");
  });

  it("returns null when document has no active element", () => {
    // Blur everything
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    // After blurring, activeElement is body with no data-focus-zone
    expect(getActiveFocusZone()).toBeNull();
  });
});
