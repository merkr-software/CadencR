import { useEffect, useState, type ReactNode } from "react";
import { animationsDisabled } from "@/lib/animations/animations-disabled";

const DURATION_MS = 200;

interface CollapsibleSectionProps {
  /** When true, the body is visible. When false, it collapses to 0 height. */
  open: boolean;
  children: ReactNode;
}

/**
 * Animated height container for expand/collapse UI.
 *
 * Uses the `grid-template-rows: 0fr → 1fr` trick so the transition runs at
 * any content height without measuring. One state (`visible`) lags `open`
 * by one frame on expand (so the browser paints the 0fr starting state
 * before flipping to 1fr) and by `DURATION_MS` on collapse (so the body
 * stays mounted long enough for the close animation to finish). The body
 * unmounts entirely once fully closed — cold-open with `open=false` renders
 * nothing.
 *
 * Honours the global `data-animations="off"` kill-switch: the deferred
 * timer / double-rAF dance is skipped so the body mounts/unmounts
 * synchronously with no transition window.
 */
export function CollapsibleSection({ open, children }: CollapsibleSectionProps) {
  const [visible, setVisible] = useState(open);

  useEffect(() => {
    if (open === visible) return;
    if (animationsDisabled()) {
      setVisible(open);
      return;
    }
    if (open) {
      // Two rAFs, not one: a single rAF fires *before* the browser paints,
      // so the `grid-rows-[0fr]` starting state would never be seen. The
      // outer frame lets the browser paint at 0fr; the inner one flips to
      // 1fr the next frame so the transition actually runs.
      let innerId = 0;
      const outerId = requestAnimationFrame(() => {
        innerId = requestAnimationFrame(() => setVisible(true));
      });
      return () => {
        cancelAnimationFrame(outerId);
        cancelAnimationFrame(innerId);
      };
    }
    const t = window.setTimeout(() => setVisible(false), DURATION_MS);
    return () => window.clearTimeout(t);
  }, [open, visible]);

  if (!open && !visible) return null;

  return (
    <div
      className={`grid transition-[grid-template-rows] duration-200 ease-[var(--ease-fluid)] ${
        open && visible ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
      }`}
      aria-hidden={!open}
    >
      <div className="min-h-0 overflow-hidden">{children}</div>
    </div>
  );
}
