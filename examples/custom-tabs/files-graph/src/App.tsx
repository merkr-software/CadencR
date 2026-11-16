import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toCadencrError } from "@cadencr/tab-sdk";
import { useCadencr, useStorage } from "@cadencr/tab-sdk/react";
import { Tabs, TabsContent, cn } from "@cadencr/tab-kit";

import { DiffPanel } from "./DiffPanel";
import { FileList } from "./FileList";
import { Header, type View } from "./Header";
import { groupByDirectory, totalsOf, type FileNode } from "./model";
import { LoadFailed, NoChanges, TreemapSkeleton } from "./states";
import { Treemap } from "./Treemap";
import { useChangedFiles, type Scope } from "./useChangedFiles";
import { useFileDiff } from "./useFileDiff";

/** Mirrors the changed-file count on the tab trigger (≤ 4 characters). */
function useFileCountBadge(count: number | null) {
  const client = useCadencr();
  useEffect(() => {
    if (count === null) return;
    const text = count === 0 ? null : count > 999 ? "999+" : String(count);
    client.ui.setBadge(text).catch((error: unknown) => {
      void client.ui.toast({
        title: "Couldn't update the tab badge",
        description: toCadencrError(error).message,
        variant: "error",
      });
    });
  }, [client, count]);
}

/** `useStorage` rolls a failed write back and exposes it as `.error` (shown in
 *  the header), so the rejected `set()` promise needs no second report. */
function reportedByUseStorage() {}

export function App() {
  const [scope, setScope] = useState<Scope>("uncommitted");
  const view = useStorage<View>("view", "treemap");
  const { state, refreshing, refreshError, reload } = useChangedFiles(scope);
  // Bumped by the Refresh button: the open diff refetches even if its counts held.
  const [reloads, setReloads] = useState(0);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const openedFrom = useRef<{ path: string; element: HTMLElement } | null>(null);

  const files = state.status === "ready" ? state.files : null;
  const groups = useMemo(() => (files ? groupByDirectory(files) : []), [files]);
  const totals = useMemo(() => (files ? totalsOf(files) : null), [files]);
  // A file that stops being changed closes its panel on the next refresh.
  const selected = useMemo(
    () => files?.find((file) => file.path === selectedPath) ?? null,
    [files, selectedPath],
  );
  const diff = useFileDiff(selected, scope, reloads);
  useFileCountBadge(totals?.files ?? null);

  const open = useCallback((file: FileNode, origin: HTMLElement) => {
    openedFrom.current = { path: file.path, element: origin };
    setSelectedPath((current) => (current === file.path ? null : file.path));
  }, []);

  const close = useCallback(() => {
    setSelectedPath(null);
    const origin = openedFrom.current;
    if (!origin) return;
    // After a view switch the opener is gone: focus the same file's new row.
    const target = origin.element.isConnected
      ? origin.element
      : document.querySelector<HTMLElement>(`[data-path="${CSS.escape(origin.path)}"]`);
    target?.focus();
  }, []);

  useEffect(() => {
    if (!selected) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      close();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selected, close]);

  const refresh = useCallback(() => {
    setReloads((value) => value + 1);
    void reload();
  }, [reload]);

  const changeScope = useCallback((next: Scope) => {
    setSelectedPath(null);
    setScope(next);
  }, []);

  let body;
  if (state.status === "loading") body = <TreemapSkeleton />;
  else if (state.status === "error") body = <LoadFailed error={state.error} onRetry={refresh} />;
  else if (state.status === "ready" && state.files.length === 0) body = <NoChanges scope={scope} />;
  else if (view.value === "list")
    body = <FileList groups={groups} selectedPath={selectedPath} onOpen={open} />;
  else body = <Treemap groups={groups} selectedPath={selectedPath} onOpen={open} />;

  return (
    // The view toggle in the header is a tab list; the main area is its panel.
    <Tabs
      value={view.value}
      onValueChange={(next) => view.set(next as View).catch(reportedByUseStorage)}
      className="h-dvh bg-background text-foreground"
    >
      <Header
        totals={totals}
        scope={scope}
        onScopeChange={changeScope}
        refreshing={refreshing}
        loading={state.status === "loading"}
        // The error state already explains a failed first load.
        refreshError={state.status === "ready" ? refreshError : null}
        viewError={view.error}
        onRefresh={refresh}
      />
      <div className="relative flex min-h-0 flex-1">
        <TabsContent
          value={view.value}
          asChild
          className={cn(
            "min-w-0 flex-1",
            view.value === "list" && state.status === "ready" ? "overflow-auto" : "p-2",
          )}
        >
          <main>{body}</main>
        </TabsContent>
        {selected ? <DiffPanel file={selected} state={diff} onClose={close} /> : null}
      </div>
    </Tabs>
  );
}
