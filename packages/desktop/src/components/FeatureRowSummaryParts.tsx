import type { ReactElement } from "react";
import { AlertTriangleIcon, ListChecksIcon } from "lucide-react";
import { FeatureMetaBadge } from "@/components/FeatureMetaBadge";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import type { RowSummary } from "@/lib/sidebar-row-summary";

/** The agent's todo progress on the meta line: "3/7", or a warning when it couldn't load. */
export function FeatureTodoProgress({ summary }: { summary: RowSummary }): ReactElement {
  const { todos, error } = summary;
  return (
    <span data-feature-todos className="inline-flex shrink-0">
      {error || !todos ? (
        <FeatureMetaBadge
          icon={<ListChecksIcon className="size-3" />}
          label={`Todo progress unavailable: ${error}`}
          className="text-destructive"
        >
          <AlertTriangleIcon className="size-3" />
        </FeatureMetaBadge>
      ) : (
        <FeatureMetaBadge
          icon={<ListChecksIcon className="size-3" />}
          label={`${todos.done} of ${todos.total} todos done`}
        >
          <span>
            {todos.done}/{todos.total}
          </span>
        </FeatureMetaBadge>
      )}
    </span>
  );
}

/**
 * The start of the agent's last reply, under the title. Holds its line while
 * loading and when there is no reply yet, so rows don't jump as previews land.
 */
export function FeatureRowPreviewLine({
  summary,
}: {
  summary: RowSummary | undefined;
}): ReactElement {
  if (!summary) return <Skeleton data-feature-preview className="my-0.5 h-3 w-32" />;
  if (summary.error) {
    return (
      <span data-feature-preview="empty" title={summary.error} className={LINE_CLASS}>
        Preview unavailable
      </span>
    );
  }
  return (
    <span data-feature-preview title={summary.preview ?? undefined} className={LINE_CLASS}>
      {summary.preview ?? " "}
    </span>
  );
}

const LINE_CLASS = "min-w-0 truncate pl-5 text-[11px] leading-4 text-muted-foreground";

/**
 * A fixed row's reply, wrapped over exactly `lines` lines of chip height, so
 * it fills what the row's details leave. Says so while it loads (a bar per
 * line), when it couldn't load, and when the agent hasn't replied yet.
 */
export function FeatureRowReply({
  summary,
  lines,
}: {
  summary: RowSummary | undefined;
  lines: number;
}): ReactElement {
  const box = { height: `${lines * 1.25}rem` };
  if (!summary) {
    return (
      <div data-feature-preview style={box} className="flex shrink-0 flex-col pl-5">
        {Array.from({ length: lines }, (_, line) => (
          <div key={line} className="flex h-5 items-center">
            <Skeleton className={cn("h-3", line === lines - 1 ? "w-24" : "w-full")} />
          </div>
        ))}
      </div>
    );
  }
  const text = summary.error ? "Preview unavailable" : summary.preview;
  return (
    <div
      data-feature-preview={text && !summary.error ? "" : "empty"}
      title={summary.error ?? summary.preview ?? undefined}
      style={{ ...box, WebkitLineClamp: lines }}
      className={cn(
        "line-clamp-1 shrink-0 pl-5 text-[11px] leading-5 break-words",
        text ? "text-muted-foreground" : "text-muted-foreground/60 italic",
      )}
    >
      {text || "No reply yet"}
    </div>
  );
}
