import type { ReactElement } from "react";

import { RUN_STATE_DOT_CLASS, runStateOf, type RunOutcome } from "@/lib/custom-actions/run-state";
import { cn } from "@/lib/utils";

/**
 * The run status dot: orange while running, red after a failure, nothing
 * otherwise (DESIGN.md "Status dot" — the color is the meaning, so a quiet
 * state gets no dot rather than a grey one). Always paired with text.
 */
export function RunStateDot({
  run,
  className,
}: {
  run: RunOutcome | null | undefined;
  className?: string;
}): ReactElement | null {
  const state = runStateOf(run);
  const color = RUN_STATE_DOT_CLASS[state];
  if (color == null) return null;
  return (
    <span
      aria-hidden
      className={cn(
        "inline-block size-2 shrink-0 rounded-full",
        color,
        state === "running" && "motion-safe:animate-pulse",
        className,
      )}
    />
  );
}
