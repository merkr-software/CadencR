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
 * A fixed row's reply, in the room of exactly `lines` lines of chip height,
 * so it fills what the row's details leave. It sets as a paragraph: at most
 * `lines` lines on a tighter leading than the chips', a single line centered
 * in its lane, a longer reply leaving its spare pixels as air above the
 * details. Says so while it loads (a bar per line), when it couldn't load,
 * and when the agent hasn't replied yet.
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
      <div data-feature-preview style={box} className="flex shrink-0 flex-col py-0.5 pl-5">
        {Array.from({ length: lines }, (_, line) => (
          <div key={line} className="flex h-4 items-center">
            <Skeleton className={cn("h-3", line === lines - 1 ? "w-24" : "w-full")} />
          </div>
        ))}
      </div>
    );
  }
  const placeholder = summary.error != null || !summary.preview;
  return (
    <div
      data-feature-preview={placeholder ? "empty" : ""}
      title={summary.error ?? summary.preview ?? undefined}
      style={{ ...box, WebkitLineClamp: lines }}
      className={cn(
        "line-clamp-1 shrink-0 py-0.5 pl-5 text-[11px] leading-4 break-words",
        placeholder ? "text-muted-foreground/60 italic" : "text-muted-foreground",
      )}
    >
      {summary.error ? "Preview unavailable" : summary.preview || "No reply yet"}
    </div>
  );
}
