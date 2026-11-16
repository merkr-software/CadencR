import { RefreshCw, Settings, TriangleAlert } from "lucide-react";
import { toCadencrError } from "@cadencr/tab-sdk";
import {
  Button,
  EmptyState,
  Skeleton,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  cn,
} from "@cadencr/tab-kit";
import { useCadencr, useStorage } from "@cadencr/tab-sdk/react";

import type { Feed } from "./github";
import { FeedRows } from "./Rows";
import { useFeed, type FeedState } from "./useFeed";

function Body({ state, onRetry }: { state: FeedState; onRetry: () => void }) {
  const client = useCadencr();
  if (state.status === "loading") {
    return (
      <div role="status" className="flex flex-col gap-3 p-4">
        <span className="sr-only">Loading…</span>
        {[80, 64, 72, 50].map((width, index) => (
          <Skeleton key={index} aria-hidden="true" className="h-4" style={{ width: `${width}%` }} />
        ))}
      </div>
    );
  }
  if (state.status === "unconfigured") {
    return (
      <EmptyState
        icon={<Settings />}
        title="Pick a repository"
        description="Set “Repository (owner/name)” for this project in Settings → Custom tabs → Endpoint watcher, e.g. merkr-software/CadencR."
      />
    );
  }
  if (state.status === "error") {
    return (
      <EmptyState
        icon={<TriangleAlert />}
        title="Couldn't reach GitHub"
        description={state.error.message}
        action={
          <Button variant="outline" size="sm" onClick={onRetry}>
            Try again
          </Button>
        }
      />
    );
  }
  const { data } = state.result;
  if (data.items.length === 0) {
    return (
      <EmptyState
        title={data.feed === "pulls" ? "No open pull requests" : "No workflow runs yet"}
      />
    );
  }
  const open = (url: string) => {
    client.ui.openExternal(url).catch((error: unknown) =>
      client.ui.toast({
        title: "Couldn't open GitHub",
        description: toCadencrError(error).message,
        variant: "error",
      }),
    );
  };
  return <FeedRows data={data} onOpen={open} />;
}

/** `useStorage` rolls a failed write back and exposes it as `.error` (shown
 *  below the header), so the rejected `set()` promise needs no second report. */
function reportedByUseStorage() {}

export function App() {
  const feed = useStorage<Feed>("feed", "pulls");
  const { state, busy, refresh } = useFeed(feed.value, !feed.loading);
  const ready = state.status === "ready" ? state : null;

  return (
    // The feed switcher is a tab list; the main area is its panel.
    <Tabs
      value={feed.value}
      onValueChange={(value) => feed.set(value as Feed).catch(reportedByUseStorage)}
      className="h-dvh bg-background text-foreground"
    >
      <header className="flex items-center justify-between gap-3 border-b border-border/60 px-4 pt-2">
        <TabsList className="h-8 w-auto border-b-0">
          <TabsTrigger value="pulls">Pull requests</TabsTrigger>
          <TabsTrigger value="runs">Workflow runs</TabsTrigger>
        </TabsList>
        <div className="flex min-w-0 items-center gap-2 pb-1.5">
          {ready ? (
            <span className="truncate font-mono text-[11px] text-muted-foreground">
              {ready.repository}
            </span>
          ) : null}
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Refresh"
            title="Refresh"
            disabled={busy}
            onClick={refresh}
          >
            <RefreshCw className={cn(busy && "motion-safe:animate-spin")} />
          </Button>
        </div>
      </header>
      {feed.error ? (
        <p role="status" className="px-4 pt-2 text-xs text-destructive">
          Couldn't load or save the selected feed: {feed.error.message}
        </p>
      ) : null}
      <TabsContent value={feed.value} asChild className="overflow-auto p-2">
        <main>
          <Body state={state} onRetry={refresh} />
        </main>
      </TabsContent>
      {ready ? (
        <footer className="border-t border-border/60 px-4 py-1.5 text-[11px] text-muted-foreground">
          {ready.result.authenticated
            ? "Authenticated with your token"
            : "Anonymous — add a token in Settings for private repositories"}
          {ready.result.rateLimitRemaining
            ? ` · ${ready.result.rateLimitRemaining} requests left this hour`
            : ""}
        </footer>
      ) : null}
    </Tabs>
  );
}
