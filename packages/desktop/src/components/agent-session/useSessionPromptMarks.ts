import { useEffect, useMemo, useRef } from "react";
import { useListSessionPrompts } from "@/api/generated";
import type { DisplayItem } from "@/types/agent-stream";
import { toastError } from "@/lib/api-errors";
import {
  collectLoadedMarks,
  mergeMarks,
  promptListDrift,
  reuseMarksIfEqual,
  type UserMessageMark,
} from "@/lib/agent-message-navigator";
import { useWsSessionStore } from "@/stores/ws-session-store";
import { useAgentSessionContext } from "./agent-session-context";

/**
 * Every prompt of the session for the navigator rail — fetched once from the
 * server so the rail doesn't grow as older history pages in — each tied to its
 * transcript row when that row is loaded.
 *
 * The list is refetched only when the transcript proves it stale (a prompt
 * persisted after the fetch, or one a rewind removed), once per distinct drift.
 */
export function useSessionPromptMarks(items: readonly DisplayItem[]): UserMessageMark[] {
  const { wsSessionId } = useAgentSessionContext();
  const sessionDbId = useWsSessionStore((s) =>
    wsSessionId ? s.sessions[wsSessionId]?.sessionDbId : undefined,
  );
  const query = useListSessionPrompts(sessionDbId ?? 0, {
    query: { enabled: sessionDbId != null, staleTime: Infinity },
  });
  const prompts = query.data?.prompts;
  const { refetch, isError, error } = query;

  useEffect(() => {
    if (isError) toastError(error, "Could not load your message list");
  }, [isError, error]);

  // Stabilized here, at the source: `items` changes on every streaming delta,
  // and a stable `loaded` lets the drift check and the merge below skip it.
  const previousLoadedRef = useRef<UserMessageMark[]>([]);
  const loaded = useMemo(() => {
    const next = reuseMarksIfEqual(previousLoadedRef.current, collectLoadedMarks(items));
    previousLoadedRef.current = next;
    return next;
  }, [items]);
  const drift = useMemo(() => promptListDrift(prompts, loaded), [prompts, loaded]);
  const lastDriftRef = useRef<string | null>(null);
  useEffect(() => {
    if (drift === null || drift === lastDriftRef.current) return;
    lastDriftRef.current = drift;
    void refetch();
  }, [drift, refetch]);

  return useMemo(() => mergeMarks(prompts, loaded), [prompts, loaded]);
}
