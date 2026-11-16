import { Badge, Button } from "@cadencr/tab-kit";

import { relativeTime, type FeedItems, type WorkflowRun } from "./github";

type Tone = "success" | "failure" | "running" | "neutral";

function runTone(run: WorkflowRun): { tone: Tone; label: string } {
  if (run.status !== "completed") return { tone: "running", label: run.status ?? "queued" };
  if (run.conclusion === "success") return { tone: "success", label: "success" };
  if (run.conclusion === "failure" || run.conclusion === "timed_out") {
    return { tone: "failure", label: run.conclusion };
  }
  return { tone: "neutral", label: run.conclusion ?? "done" };
}

/** A ghost kit Button stretched into a row: hover, focus ring and disabled
 *  styling come from the kit. */
const ROW = "h-auto w-full justify-start gap-3 px-3 py-2 text-left text-xs font-normal";

/** Rows open on GitHub (after Cadencr asks the user to confirm). */
export function FeedRows({ data, onOpen }: { data: FeedItems; onOpen: (url: string) => void }) {
  if (data.feed === "pulls") {
    return (
      <ul className="flex flex-col">
        {data.items.map((pr) => (
          <li key={pr.id}>
            <Button variant="ghost" className={ROW} onClick={() => onOpen(pr.html_url)}>
              <span className="w-12 shrink-0 font-mono text-[11px] text-muted-foreground">
                #{pr.number}
              </span>
              <span className="min-w-0 flex-1 truncate">{pr.title}</span>
              {pr.draft ? <Badge variant="outline">Draft</Badge> : null}
              <span className="shrink-0 text-muted-foreground">
                {pr.user?.login ?? "ghost"} · {relativeTime(pr.updated_at)}
              </span>
            </Button>
          </li>
        ))}
      </ul>
    );
  }
  return (
    <ul className="flex flex-col">
      {data.items.map((run) => {
        const { tone, label } = runTone(run);
        return (
          <li key={run.id}>
            <Button variant="ghost" className={ROW} onClick={() => onOpen(run.html_url)}>
              <span
                data-tone={tone}
                className="run-dot size-2 shrink-0 rounded-full"
                aria-hidden="true"
              />
              <span className="sr-only">{label}</span>
              <span className="min-w-0 flex-1 truncate">
                <span className="font-medium">{run.name ?? "Workflow"}</span>
                <span className="text-muted-foreground"> · {run.display_title}</span>
              </span>
              <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                {run.head_branch ?? ""}
              </span>
              <span className="w-24 shrink-0 text-right text-muted-foreground">
                {relativeTime(run.updated_at)}
              </span>
            </Button>
          </li>
        );
      })}
    </ul>
  );
}
