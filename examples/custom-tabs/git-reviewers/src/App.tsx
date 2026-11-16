import { useEffect, useState } from "react";
import { ChevronRight, RefreshCw, TerminalSquare, TriangleAlert, Users } from "lucide-react";
import { toCadencrError } from "@cadencr/tab-sdk";
import { useCadencr } from "@cadencr/tab-sdk/react";
import { Badge, Button, EmptyState, Skeleton, cn } from "@cadencr/tab-kit";

import type { Person } from "./model";
import { useReviewers } from "./useReviewers";

const ago = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

function relative(at: number): string {
  const days = Math.round((at - Date.now()) / 86_400_000);
  if (Math.abs(days) < 1) return "today";
  if (Math.abs(days) < 60) return ago.format(days, "day");
  return ago.format(Math.round(days / 30), "month");
}

/** The number of suggested reviewers (you excluded) on the tab trigger. */
function useReviewerBadge(people: Person[] | null) {
  const client = useCadencr();
  const count = people?.filter((person) => !person.isYou).length ?? null;
  useEffect(() => {
    if (count === null) return;
    client.ui.setBadge(count === 0 ? null : count > 999 ? "999+" : String(count)).catch((error: unknown) => {
      void client.ui.toast({
        title: "Couldn't update the tab badge",
        description: toCadencrError(error).message,
        variant: "error",
      });
    });
  }, [client, count]);
}

export function App() {
  const { state, refreshing, reload } = useReviewers();
  const people = state.status === "ready" ? state.people : null;
  useReviewerBadge(people);
  return (
    <main className="flex h-screen flex-col bg-background text-foreground">
      <header className="flex items-center gap-3 border-b border-border px-4 py-3">
        <Users className="size-4 text-muted-foreground" aria-hidden />
        <div className="min-w-0 flex-1">
          <h1 className="text-sm font-semibold">Who knows this code</h1>
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <TerminalSquare className="size-3" aria-hidden />
            {state.status === "ready"
              ? `From the history of ${state.filesRead} changed file${state.filesRead === 1 ? "" : "s"} on ${state.revision}, read with git.`
              : "Reads the Git history of the files this branch changes."}
          </p>
        </div>
        <Button variant="ghost" size="icon-xs" aria-label="Refresh" onClick={reload} disabled={refreshing}>
          <RefreshCw className={cn(refreshing && "animate-spin")} />
        </Button>
      </header>
      <section className="min-h-0 flex-1 overflow-y-auto p-3">
        <Body state={state} onRetry={reload} />
      </section>
    </main>
  );
}

function Body({ state, onRetry }: { state: ReturnType<typeof useReviewers>["state"]; onRetry: () => void }) {
  if (state.status === "loading") {
    return (
      <div role="status" className="space-y-2">
        <span className="sr-only">Reading the Git history…</span>
        {[0, 1, 2].map((row) => (
          <Skeleton key={row} aria-hidden="true" className="h-14 rounded-lg" />
        ))}
      </div>
    );
  }
  if (state.status === "error") {
    return (
      <EmptyState
        icon={<TriangleAlert />}
        title="Couldn't read the history"
        description={`${state.error.code}: ${state.error.message}`}
        action={
          <Button variant="outline" size="sm" onClick={onRetry}>
            Try again
          </Button>
        }
        className="h-full"
      />
    );
  }
  if (state.people.length === 0) {
    return (
      <EmptyState
        icon={<Users />}
        title={state.filesRead === 0 ? "No changes yet" : "No history yet"}
        description={
          state.filesRead === 0
            ? "Change a file and the people who know it show up here."
            : `None of the changed files has commits on ${state.revision}: they are all new.`
        }
        className="h-full"
      />
    );
  }
  return (
    <>
      <ul className="space-y-1.5" aria-label="People who know the changed code">
        {state.people.map((person) => (
          <PersonRow key={person.email} person={person} />
        ))}
      </ul>
      {state.filesSkipped > 0 ? (
        <p className="mt-3 text-xs text-muted-foreground">
          {state.filesSkipped} more changed {state.filesSkipped === 1 ? "file was" : "files were"} not read, to keep this quick.
        </p>
      ) : null}
    </>
  );
}

function PersonRow({ person }: { person: Person }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="rounded-lg border border-border bg-card">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="truncate text-sm font-medium">{person.name}</span>
            {person.isYou ? <Badge variant="secondary">You</Badge> : null}
          </span>
          <span className="block truncate font-mono text-[11px] text-muted-foreground">{person.email}</span>
        </span>
        <span className="shrink-0 text-right text-xs text-muted-foreground">
          <span className="block text-foreground">
            {person.files.length} file{person.files.length === 1 ? "" : "s"} · {person.commits} commit
            {person.commits === 1 ? "" : "s"}
          </span>
          last {relative(person.lastAt)}
        </span>
        <ChevronRight className={cn("size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} aria-hidden />
      </button>
      {open ? (
        <ul className="border-t border-border/60 px-3 py-2" aria-label={`Files ${person.name} changed`}>
          {person.files.map((file) => (
            <li key={file.path} className="flex justify-between gap-3 py-0.5 text-xs">
              <span className="truncate font-mono text-[11px]">{file.path}</span>
              <span className="shrink-0 text-muted-foreground">{file.commits}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}
