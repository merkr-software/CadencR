import { useLayoutEffect, useRef, useState, type ReactElement } from "react";
import { cn } from "@/lib/utils";

/** Muted text clamped to 3 lines, with a "Show more" toggle only when it is cut. */
export function ExpandableText({ text, touch }: { text: string; touch: boolean }): ReactElement {
  const ref = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [clamped, setClamped] = useState(false);

  // One layout read per text, while clamped: once expanded the toggle stays.
  useLayoutEffect(() => {
    const element = ref.current;
    if (element && !expanded) setClamped(element.scrollHeight > element.clientHeight + 1);
  }, [text, expanded]);

  return (
    <div className="flex flex-col items-start gap-0.5">
      <p
        ref={ref}
        className={cn(
          "whitespace-pre-wrap break-words leading-snug text-muted-foreground",
          touch ? "text-sm" : "text-xs",
          expanded ? "max-h-[14lh] overflow-y-auto" : "line-clamp-3",
        )}
      >
        {text}
      </p>
      {clamped || expanded ? (
        <button
          type="button"
          aria-expanded={expanded}
          className={cn(
            "rounded-sm text-primary hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
            touch ? "min-h-11 text-sm" : "text-[11px]",
          )}
          onClick={() => setExpanded((previous) => !previous)}
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      ) : null}
    </div>
  );
}
