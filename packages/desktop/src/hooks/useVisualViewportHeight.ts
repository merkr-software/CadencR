import { useEffect } from "react";

// Keyboards are tall; URL-bar show/hide and safe-area jitter are short. This
// threshold cleanly separates "the on-screen keyboard is open" from that noise,
// so we only re-anchor the shell for a real keyboard.
const KEYBOARD_INSET_THRESHOLD = 120;

/**
 * Keeps the mobile app shell sized to the *visible* viewport while the
 * on-screen keyboard is open.
 *
 * The whole mobile layout flows from the `--app-vh` CSS variable (index.css),
 * set to `100dvh`/`100lvh`. Those units track the URL bar but NOT the keyboard,
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
 * Below the threshold we drop the override so the CSS unit takes back over.
 * That fallback is deliberate: it never regresses the iOS standalone case,
 * where only `lvh` spans the full screen (see index.css).
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

    // The keyboard slide fires many resize ticks at the same final height, so
    // cache the last write and skip redundant style mutations.
    let lastHeightPx: number | null = null;
    const sync = (): void => {
      // Undo any pan before measuring: a panned viewport inflates `offsetTop`,
      // which under-reports the inset below and drops (or never applies) the
      // override, leaving the shell sized to the full screen while only the
      // strip above the keyboard is visible — the prompt you just focused is
      // then off-screen entirely.
      //
      // Unconditional on purpose: gating this on an already-known-open keyboard
      // means the first focus of a session measures a viewport iOS has already
      // panned, and the override never applies. See the regression test.
      undoPan();

      const inset = window.innerHeight - vv.height - vv.offsetTop;
      const heightPx = inset > KEYBOARD_INSET_THRESHOLD ? Math.round(vv.height) : null;
      if (heightPx !== lastHeightPx) {
        lastHeightPx = heightPx;
        if (heightPx === null) root.style.removeProperty("--app-vh");
        else root.style.setProperty("--app-vh", `${heightPx}px`);
      }
    };

    // The pan can also arrive as a standalone visualViewport scroll (no height
    // change) right after focus. A scroll never changes `vv.height`, so don't
    // re-measure here — just re-pin. `undoPan`'s guard makes the scroll its own
    // `scrollTo` fires a no-op, so this stays a single, self-terminating reset.
    const repin = (): void => {
      if (lastHeightPx !== null) undoPan();
    };

    sync();
    vv.addEventListener("resize", sync);
    vv.addEventListener("scroll", repin);
    return () => {
      vv.removeEventListener("resize", sync);
      vv.removeEventListener("scroll", repin);
      root.style.removeProperty("--app-vh");
    };
  }, [enabled]);
}
