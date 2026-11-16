// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { initializeStandaloneViewport } from "./standalone-viewport";

describe("initializeStandaloneViewport", () => {
  let detach: (() => void) | undefined;

  afterEach(() => {
    detach?.();
    document.documentElement.classList.remove("is-standalone");
    document.documentElement.style.removeProperty("--standalone-vh");
    vi.restoreAllMocks();
  });

  it("seeds the available layout height and follows orientation changes", () => {
    const height = vi.spyOn(window, "innerHeight", "get").mockReturnValue(812);
    detach = initializeStandaloneViewport();
    const root = document.documentElement;
    expect(root.classList.contains("is-standalone")).toBe(true);
    expect(root.style.getPropertyValue("--standalone-vh")).toBe("812px");

    height.mockReturnValue(402);
    window.dispatchEvent(new Event("resize"));
    expect(root.style.getPropertyValue("--standalone-vh")).toBe("402px");

    detach();
    height.mockReturnValue(812);
    window.dispatchEvent(new Event("resize"));
    expect(root.style.getPropertyValue("--standalone-vh")).toBe("402px");
  });
});
