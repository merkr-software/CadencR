import { watchViewport } from "./viewport-settle";

/** Tracks the layout viewport for the lifetime of an installed app document. */
export function initializeStandaloneViewport(): () => void {
  const root = document.documentElement;
  root.classList.add("is-standalone");

  // Unlike lvh on affected iOS releases, innerHeight excludes the status bar
  // in default mode. CSS adds the safe-area top for older translucent installs
  // and caps at lvh so releases that already include the inset don't overshoot.
  // The layout viewport only: iOS shrinks `innerHeight` with the keyboard and
  // a pinch-zoom, which fire the visual viewport's `resize` alone
  // (`useVisualViewportHeight` handles the keyboard).
  let lastHeight = 0;
  return watchViewport(
    () => {
      const height = window.innerHeight;
      if (height === lastHeight) return;
      lastHeight = height;
      root.style.setProperty("--standalone-vh", `${height}px`);
    },
    { visualViewport: false },
  );
}
