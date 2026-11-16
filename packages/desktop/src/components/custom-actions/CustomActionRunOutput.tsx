import { memo, useLayoutEffect, useMemo, useRef, type ReactElement } from "react";

import type { CustomActionRun } from "@/api/generated";
import { parseAnsi } from "@/lib/ansi-to-html";
import { cn } from "@/lib/utils";

/** Pixels from the bottom within which the view keeps following new output. */
const FOLLOW_THRESHOLD_PX = 24;

/**
 * A run's captured output on the dark code surface, ANSI colors kept. stderr
 * follows stdout, as a terminal would interleave them closely enough for a
 * glance. While the run streams, the view follows the tail unless the user
 * scrolled up to read.
 */
export const CustomActionRunOutput = memo(function CustomActionRunOutput({
  run,
  className,
}: {
  run: CustomActionRun;
  /** Sets the height: the output scrolls inside it. */
  className?: string;
}): ReactElement {
  const text = useMemo(
    () => [run.stdout.trimEnd(), run.stderr.replace(/^\n+/, "")].filter(Boolean).join("\n"),
    [run],
  );
  const rendered = useMemo(() => parseAnsi(text), [text]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);

  // Re-arm following when another run is shown.
  useLayoutEffect(() => {
    followRef.current = true;
  }, [run.id]);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (element && followRef.current) element.scrollTop = element.scrollHeight;
  }, [rendered]);

  const running = run.ended_at == null;
  return (
    <div
      ref={scrollRef}
      role="log"
      aria-live={running ? "polite" : "off"}
      aria-label="Run output"
      tabIndex={0}
      onScroll={(event) => {
        const element = event.currentTarget;
        followRef.current =
          element.scrollHeight - element.scrollTop - element.clientHeight <= FOLLOW_THRESHOLD_PX;
      }}
      className={cn(
        "min-h-0 overflow-auto rounded-md bg-[var(--code-bg)] px-3 py-2 font-mono text-xs leading-5 text-[var(--code-fg)] focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
        className,
      )}
    >
      {text ? (
        <pre className="whitespace-pre-wrap break-words">{rendered}</pre>
      ) : (
        <p className="text-[var(--code-fg)]/60 italic">
          {running ? "Waiting for output…" : "The command printed nothing."}
        </p>
      )}
    </div>
  );
});
