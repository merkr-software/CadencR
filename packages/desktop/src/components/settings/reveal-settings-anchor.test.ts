// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { revealSettingsAnchor, showSettingsTarget } from "./reveal-settings-anchor";

afterEach(() => {
  document.body.innerHTML = "";
});

function setup(): HTMLElement {
  // The app shell's resizable sidebar panel is `#sidebar`, ahead of the page.
  document.body.innerHTML = `
    <div id="sidebar">app sidebar</div>
    <main><section id="sidebar">settings group</section></main>`;
  const main = document.querySelector("main");
  if (!main) throw new Error("no main");
  return main;
}

describe("revealSettingsAnchor", () => {
  it("outlines the anchor inside the settings page, never app chrome sharing its id", () => {
    const main = setup();
    expect(revealSettingsAnchor("sidebar", main)).toBe(true);
    expect(main.querySelector("section")).toHaveAttribute("data-settings-flash");
    expect(document.body.firstElementChild).not.toHaveAttribute("data-settings-flash");
  });

  it("drops the outline after its animation", () => {
    vi.useFakeTimers();
    const main = setup();
    revealSettingsAnchor("sidebar", main);
    vi.advanceTimersByTime(1600);
    expect(main.querySelector("section")).not.toHaveAttribute("data-settings-flash");
    vi.useRealTimers();
  });

  it("reports an anchor the page doesn't render, so the caller shows the top", () => {
    const main = setup();
    main.scrollTop = 300;
    expect(revealSettingsAnchor('no-such"anchor', main)).toBe(false);
    showSettingsTarget(main, "no-such-anchor");
    expect(main.scrollTop).toBe(0);
  });
});
