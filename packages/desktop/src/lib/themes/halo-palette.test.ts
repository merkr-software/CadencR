// @vitest-environment jsdom
// Pinned to jsdom: the palette is read off a live document.
import { afterEach, describe, expect, it, vi } from "vitest";
import { readHaloPalette } from "./halo-palette";

/** A `getComputedStyle` stand-in: only the tokens it is given resolve. */
function stubComputedStyle(values: Record<string, string>): void {
  vi.spyOn(window, "getComputedStyle").mockReturnValue({
    getPropertyValue: (property: string) => values[property] ?? "",
  } as unknown as CSSStyleDeclaration);
}

describe("readHaloPalette", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reads every accent and chart token the theme declares", () => {
    stubComputedStyle({
      "--acc-cyan": "oklch(0.82 0.11 205)",
      "--acc-pink": "#f5c2e7",
      "--chart-1": "#cba6f7",
    });

    // In the order the theme vocabulary declares them: the categorical chart
    // set first, then the vibrant accents.
    expect(readHaloPalette(document.documentElement)).toEqual([
      { token: "--chart-1", color: "#cba6f7" },
      { token: "--acc-cyan", color: "oklch(0.82 0.11 205)" },
      { token: "--acc-pink", color: "#f5c2e7" },
    ]);
  });

  it("drops a token that resolves to nothing rather than painting a blank swatch", () => {
    stubComputedStyle({ "--acc-cyan": "  ", "--acc-green": "#a6e3a1" });

    expect(readHaloPalette(document.documentElement)).toEqual([
      { token: "--acc-green", color: "#a6e3a1" },
    ]);
  });

  it("returns nothing when the theme declares none of them", () => {
    stubComputedStyle({});

    expect(readHaloPalette(document.documentElement)).toEqual([]);
  });

  it("leaves out the muted comment grey, which would paint a dead halo", () => {
    stubComputedStyle({ "--acc-comment": "#6c7086", "--acc-cyan": "#89dceb" });

    expect(readHaloPalette(document.documentElement)).toEqual([
      { token: "--acc-cyan", color: "#89dceb" },
    ]);
  });
});
