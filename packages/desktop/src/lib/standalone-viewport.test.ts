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

  it("keeps reading the height after a fold whose last change fires no event", () => {
    vi.useFakeTimers();
    try {
      const height = vi.spyOn(window, "innerHeight", "get").mockReturnValue(648);
      detach = initializeStandaloneViewport();
      const root = document.documentElement;
      // Unfolding: one resize with the folded height, then it grows silently.
      window.dispatchEvent(new Event("resize"));
      height.mockReturnValue(930);
      vi.advanceTimersByTime(100);
      expect(root.style.getPropertyValue("--standalone-vh")).toBe("930px");

      // Settled: no more reads until the next event.
      vi.advanceTimersByTime(1000);
      height.mockReturnValue(500);
      vi.advanceTimersByTime(1000);
      expect(root.style.getPropertyValue("--standalone-vh")).toBe("930px");
    } finally {
      vi.useRealTimers();
    }
  });
});
