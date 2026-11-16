import { useEffect } from "react";

// Keyboards are tall; URL-bar show/hide and safe-area jitter are short. This
// threshold cleanly separates "the on-screen keyboard is open" from that noise,
// so we only re-anchor the shell for a real keyboard.
const KEYBOARD_INSET_THRESHOLD = 120;

/**
 * Keeps the mobile app shell sized to the *visible* viewport while the
 * on-screen keyboard is open.
 *
 * The whole mobile layout flows from the `--app-vh` CSS variable (app-viewport.css),
 * based on the viewport height. CSS viewport units do NOT track the keyboard,
 * so an input pinned to the bottom of the screen — the terminal prompt, most
 * visibly — ends up hidden behind the keyboard with no way to see what you type.
 *
 * `window.visualViewport.height` is the one measurement that shrinks when the
 * keyboard appears. When the gap between the layout viewport and the visual
 * viewport grows past a keyboard-sized threshold, we pin `--app-vh` to the
 * visible height (px) so the shell collapses to the area above the keyboard and
 * the focused input stays in view. The terminal's own ResizeObserver
 * (TerminalCoreInstance) refits the PTY to the smaller box, lifting the prompt clear.
 *
 * Below the threshold we drop the override so the browser/standalone CSS
 * sizing takes back over, including the installed status-bar mode (app-viewport.css).
 */
export function useVisualViewportHeight(enabled: boolean): void {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!enabled || !vv) return;

    const root = document.documentElement;

    // Focusing a bottom-pinned input (the agent prompt, the terminal) makes
    // mobile browsers *pan the layout viewport up* to lift the caret above the
    // on-screen keyboard. But our shell is anchored at the document's top and
    // only collapses to the visible viewport height (below) — so that pan does
    // not reveal anything, it just shoves the whole shell, prompt included, off
    // the top of the screen, sometimes far enough that the input you just
    // focused is no longer visible. While the keyboard is open we keep the
    // document pinned to the top so the collapsed shell stays aligned with the
    // visible area. (`overflow: hidden` on the document does not stop iOS from
    // caret-scrolling, so this reset is what actually holds it in place.)
    const undoPan = (): void => {
      if (window.scrollX !== 0 || window.scrollY !== 0) window.scrollTo(0, 0);
    };

    // The layout viewport's height, i.e. the full screen the shell would fill
    // without a keyboard. `innerHeight` alone is not it: iOS 26 Safari shrinks
    // `innerHeight` along with the visual viewport, and whether it has already
    // done so when the keyboard's `resize` tick lands is a race — on the losing
    // side the inset read ~0, the override never applied, and the prompt stayed
    // under the keyboard. The root's `clientHeight` (the initial containing
    // block) holds still while the keyboard is up; the max keeps whichever is
    // the true full height when the URL bar collapses and `innerHeight` briefly
    // exceeds it.
    const layoutHeight = (): number => Math.max(window.innerHeight, root.clientHeight);

    // The keyboard slide fires many resize ticks at the same final height, so
    // cache the last write and skip redundant style mutations.
    let lastHeightPx: number | null = null;
    const sync = (): void => {
      // A height difference, not `offsetTop`: iOS pans the viewport to lift the
      // caret around the same tick it reports the keyboard, and a panned
      // `offsetTop` under-reported the inset (the very first focus of a session
      // used to miss the override that way). The pan doesn't change heights.
      // Scaled back to layout pixels: a pinch zoom shrinks `vv.height` too, and
      // read raw it passed for a keyboard.
      const visibleHeight = vv.height * vv.scale;
      const inset = layoutHeight() - visibleHeight;
      const heightPx = inset > KEYBOARD_INSET_THRESHOLD ? Math.round(visibleHeight) : null;
      if (heightPx !== lastHeightPx) {
        lastHeightPx = heightPx;
        if (heightPx === null) {
          root.style.removeProperty("--app-vh");
          delete root.dataset.keyboardOpen;
        } else {
          root.style.setProperty("--app-vh", `${heightPx}px`);
          root.dataset.keyboardOpen = "";
        }
      }
      undoPan();
    };

    // iOS computes its caret-reveal pan from the layout *before* the shell
    // collapses, then applies it after: the collapsed shell lands ~a keyboard
    // height too high and the prompt leaves through the top of the screen. The
    // pan reaches the document as a window `scroll` right away, while the
    // matching visualViewport `scroll` trails it by ~400ms (measured on iOS 26),
    // so re-pin on both; waiting for the latter left the prompt visibly gone.
    // A scroll never changes `vv.height`, so don't re-measure here. `undoPan`'s
    // guard makes the scroll its own `scrollTo` fires a no-op, so this stays a
    // single, self-terminating reset. With the keyboard closed a stray pan is
    // left alone.
    const repin = (): void => {
      if (lastHeightPx !== null) undoPan();
    };

    sync();
    vv.addEventListener("resize", sync);
    vv.addEventListener("scroll", repin);
    window.addEventListener("scroll", repin);
    return () => {
      vv.removeEventListener("resize", sync);
      vv.removeEventListener("scroll", repin);
      window.removeEventListener("scroll", repin);
      root.style.removeProperty("--app-vh");
      delete root.dataset.keyboardOpen;
    };
  }, [enabled]);
}
