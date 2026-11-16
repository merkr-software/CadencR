import { useEffect, useState } from "react";
import { Cpu, RefreshCw, Server, Square, TriangleAlert } from "lucide-react";
import { toCadencrError } from "@cadencr/tab-sdk";
import { useCadencr } from "@cadencr/tab-sdk/react";
import { Badge, Button, EmptyState, Skeleton, cn } from "@cadencr/tab-kit";

import { usePorts, type PortEntry } from "./usePorts";

/** How many ports processes in this conversation's folder hold, on the tab trigger. */
function useFolderBadge(count: number | null) {
  const client = useCadencr();
  useEffect(() => {
    if (count === null) return;
    client.ui
      .setBadge(count === 0 ? null : count > 999 ? "999+" : String(count))
      .catch((error: unknown) => {
        void client.ui.toast({
          title: "Couldn't update the tab badge",
          description: toCadencrError(error).message,
          variant: "error",
        });
      });
  }, [client, count]);
}

export function App() {
  const { state, conversation, conversationLoading, refreshing, reload, stop } = usePorts();
  const ports = state.status === "ready" ? state.ports : null;
  const mine = ports?.filter((entry) => entry.inFolder === true) ?? [];
  const others = ports?.filter((entry) => entry.inFolder !== true) ?? [];
  useFolderBadge(ports ? mine.length : null);

  return (
    <main className="flex h-screen flex-col bg-background text-foreground">
      <header className="flex items-center gap-3 border-b border-border px-4 py-3">
        <Server className="size-4 text-muted-foreground" aria-hidden />
        <div className="min-w-0 flex-1">
          <h1 className="text-sm font-semibold">Listening ports</h1>
          <p className="flex items-center gap-1.5 truncate text-xs text-muted-foreground">
            <Cpu className="size-3 shrink-0" aria-hidden />
            Read by this tab's native backend
            {conversation ? ` · ${conversation.title}` : null}
            {conversationLoading ? (
              <Skeleton className="h-3 w-24" aria-label="Loading the conversation" />
            ) : null}
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Refresh"
          onClick={() => void reload()}
          disabled={refreshing}
        >
          <RefreshCw className={cn(refreshing && "animate-spin")} />
        </Button>
      </header>
      <section className="min-h-0 flex-1 space-y-5 overflow-y-auto p-3">
        {state.status === "loading" ? <Loading /> : null}
        {state.status === "error" ? (
          <Failed
            message={`${state.error.code}: ${state.error.message}`}
            onRetry={() => void reload()}
          />
        ) : null}
        {ports ? (
          <>
            <PortGroup
              title="In this conversation's folder"
              empty="Nothing running in this conversation's folder is listening. Start a dev server there and it shows up here."
              entries={mine}
              onStop={stop}
            />
            <PortGroup
              title="Elsewhere on this computer"
              empty="No other process is listening."
              entries={others}
            />
          </>
        ) : null}
      </section>
    </main>
  );
}

function Loading() {
  return (
    <div role="status" className="space-y-2">
      <span className="sr-only">Starting the backend and listing ports…</span>
      {[0, 1, 2].map((row) => (
        <Skeleton key={row} aria-hidden="true" className="h-12 rounded-lg" />
      ))}
    </div>
  );
}

/** A service message as a sentence: its final stop added once, never doubled. */
function sentence(message: string): string {
  const text = message.trim();
  return /[.!?…]$/.test(text) ? text : `${text}.`;
}

function Failed({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <EmptyState
      icon={<TriangleAlert />}
      title="The backend couldn't list the ports"
      description={`${sentence(message)} Its log is in the tab's Activity (+ menu → Activity).`}
      action={
        <Button variant="outline" size="sm" onClick={onRetry}>
          Try again
        </Button>
      }
      className="h-full"
    />
  );
}

function PortGroup({
  title,
  empty,
  entries,
  onStop,
}: {
  title: string;
  empty: string;
  entries: PortEntry[];
  onStop?: (entry: PortEntry) => Promise<void>;
}) {
  return (
    <div className="space-y-2">
      <h2 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
        {title} <span className="font-normal">({entries.length})</span>
      </h2>
      {entries.length === 0 ? (
        <p className="text-xs text-muted-foreground">{empty}</p>
      ) : (
        <ul
          className="divide-y divide-border/60 rounded-lg border border-border bg-card"
          aria-label={title}
        >
          {entries.map((entry) => (
            <PortRow key={`${entry.pid}:${entry.port}`} entry={entry} onStop={onStop} />
          ))}
        </ul>
      )}
    </div>
  );
}

function PortRow({
  entry,
  onStop,
}: {
  entry: PortEntry;
  onStop?: (entry: PortEntry) => Promise<void>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
      <span className="w-14 shrink-0 font-mono text-sm font-semibold tabular-nums">
        {entry.port}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2 text-sm">
          <span className="truncate">{entry.command || "unknown"}</span>
          <span className="font-mono text-[11px] text-muted-foreground">pid {entry.pid}</span>
          {entry.inFolder ? <Badge variant="secondary">This folder</Badge> : null}
        </span>
        <span className="block truncate font-mono text-[11px] text-muted-foreground">
          {entry.addresses.join(", ")}
          {entry.cwd ? ` · ${entry.cwd}` : ""}
        </span>
      </span>
      {onStop ? (
        confirming ? (
          <span className="flex shrink-0 gap-1.5">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setConfirming(false)}
              disabled={stopping}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={stopping}
              onClick={() => {
                setStopping(true);
                setFailure(null);
                onStop(entry)
                  // The toast reporting the outcome could not be shown: say it here.
                  .catch((error: unknown) => setFailure(toCadencrError(error).message))
                  .finally(() => {
                    setStopping(false);
                    setConfirming(false);
                  });
              }}
            >
              {stopping ? "Stopping…" : `Stop ${entry.command}`}
            </Button>
          </span>
        ) : (
          <Button variant="outline" size="sm" onClick={() => setConfirming(true)}>
            <Square aria-hidden />
            Stop
          </Button>
        )
      ) : null}
      {failure ? (
        <span role="alert" className="basis-full pl-17 text-[11px] text-destructive">
          Couldn&apos;t report the result: {failure}
        </span>
      ) : null}
    </li>
  );
}
