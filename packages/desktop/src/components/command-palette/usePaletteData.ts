import { useCallback, useEffect, useMemo, useState } from "react";
import { keepPreviousData } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  useFileSearch,
  useListConversationIndex,
  useListProjects,
  useSearchMessages,
  type ConversationIndexEntry,
  type MessageSearchHit,
  type Project,
} from "@/api/generated";
import { useAttentionIndex } from "@/hooks/useAttentionIndex";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { apiErrorMessage } from "@/lib/api-errors";
import {
  readFrecency,
  recordPick,
  writeFrecency,
  type FrecencyMap,
} from "@/lib/command-palette/palette-frecency";
import type { PaletteScope } from "@/lib/command-palette/palette-query";
import { deriveNextActions, type NextActionEntry } from "@/lib/next-actions";
import type { AttentionState } from "@/lib/sidebar-attention";
import { useUnreadStore } from "@/stores/unread-store";
import { usePrStatusStore } from "@/stores/usePrStatusStore";

const INDEX_STALE_MS = 15_000;
const REMOTE_DEBOUNCE_MS = 160;
const NO_CONVERSATIONS: readonly ConversationIndexEntry[] = [];
const NO_PROJECTS: readonly Project[] = [];
const NO_HITS: readonly MessageSearchHit[] = [];

export interface PaletteSources {
  conversations: readonly ConversationIndexEntry[];
  conversationsLoading: boolean;
  conversationsError: string | null;
  projects: readonly Project[];
  projectNames: ReadonlyMap<number, string>;
  attention: ReadonlyMap<number, AttentionState>;
  nextActions: readonly NextActionEntry[];
}

/**
 * What the palette searches locally, fetched when it opens: every conversation
 * (archives included), projects, and the live attention state the sidebar
 * already holds (no request).
 */
export function usePaletteSources(): PaletteSources {
  const index = useListConversationIndex({ query: { staleTime: INDEX_STALE_MS } });
  const projectsQuery = useListProjects();
  const attentionEntries = useAttentionIndex();
  const prByFeature = usePrStatusStore((state) => state.byFeature);
  const prAcks = useUnreadStore((state) => state.prAcks);
  // The index already holds every conversation: no per-conversation lookups.
  const nextActions = useMemo(
    () => deriveNextActions(attentionEntries, prByFeature, prAcks),
    [attentionEntries, prAcks, prByFeature],
  );
  const projects = projectsQuery.data ?? NO_PROJECTS;
  return useMemo(
    () => ({
      conversations: index.data ?? NO_CONVERSATIONS,
      conversationsLoading: index.isPending,
      conversationsError: index.error
        ? apiErrorMessage(index.error, "Couldn't load conversations")
        : null,
      projects,
      projectNames: new Map(projects.map((project) => [project.id, project.name])),
      attention: new Map(attentionEntries.map((entry) => [entry.featureId, entry.state])),
      nextActions,
    }),
    [attentionEntries, index.data, index.error, index.isPending, nextActions, projects],
  );
}

/** Past picks, read once per opening; a pick is written through immediately. */
export function usePaletteFrecency(): {
  frecency: FrecencyMap;
  recordUse: (key: string) => void;
} {
  const [stored] = useState(readFrecency);
  const [frecency, setFrecency] = useState<FrecencyMap>(stored.map);
  useEffect(() => {
    if (stored.error) {
      toast.error("Palette history was unreadable and has been reset", {
        description: stored.error,
      });
    }
  }, [stored.error]);
  const recordUse = useCallback((key: string) => {
    setFrecency((current) => {
      const next = recordPick(current, key, Date.now());
      try {
        writeFrecency(next);
      } catch (error) {
        toast.error("Couldn't save palette history", {
          description: error instanceof Error ? error.message : String(error),
        });
      }
      return next;
    });
  }, []);
  return useMemo(() => ({ frecency, recordUse }), [frecency, recordUse]);
}

export interface RemoteResults<T> {
  items: readonly T[];
  loading: boolean;
  error: string | null;
}

const NO_RESULTS = { items: [], loading: false, error: null } as const;

/** A search request's state; `fetching` also covers the debounce before it starts. */
function remoteResults<T>(
  items: readonly T[],
  { fetching, error, failure }: { fetching: boolean; error: unknown; failure: string },
): RemoteResults<T> {
  return { items, loading: fetching, error: error ? apiErrorMessage(error, failure) : null };
}

/** Message hits for `text`, debounced; nothing below `minChars`. */
export function usePaletteMessages(
  text: string,
  options: {
    enabled: boolean;
    minChars: number;
    scope: PaletteScope;
    projectId: number | null;
    limit: number;
  },
): RemoteResults<MessageSearchHit> {
  const debounced = useDebouncedValue(text.trim(), REMOTE_DEBOUNCE_MS);
  const enabled = options.enabled && debounced.length >= options.minChars;
  const query = useSearchMessages(
    {
      q: debounced,
      limit: options.limit,
      project_id: options.scope === "project" ? options.projectId : undefined,
      active_only: options.scope === "active",
    },
    { query: { enabled, placeholderData: keepPreviousData, staleTime: 10_000 } },
  );
  const fetching = query.isFetching || debounced !== text.trim();
  const { data, error } = query;
  return useMemo(
    () =>
      enabled
        ? remoteResults(data ?? NO_HITS, { fetching, error, failure: "Message search failed" })
        : NO_RESULTS,
    [data, enabled, error, fetching],
  );
}

export interface FileHit {
  path: string;
  positions: readonly number[];
}

/** Files of the open conversation's worktree matching `text` (recent files when empty). */
export function usePaletteFiles(
  text: string,
  options: { enabled: boolean; projectId: number | null; featureId: number | null; limit: number },
): RemoteResults<FileHit> {
  const debounced = useDebouncedValue(text.trim(), REMOTE_DEBOUNCE_MS);
  const enabled = options.enabled && options.projectId != null;
  const query = useFileSearch(
    {
      project_id: options.projectId ?? 0,
      feature_id: options.featureId,
      query: debounced || undefined,
    },
    { query: { enabled, placeholderData: keepPreviousData, staleTime: 10_000 } },
  );
  const items = useMemo(
    () =>
      (query.data?.files ?? [])
        .filter((file) => !file.is_dir)
        .slice(0, options.limit)
        .map((file) => ({ path: file.path, positions: file.positions })),
    [options.limit, query.data],
  );
  const fetching = query.isFetching || debounced !== text.trim();
  const { error } = query;
  return useMemo(
    () =>
      enabled
        ? remoteResults(items, { fetching, error, failure: "File search failed" })
        : NO_RESULTS,
    [enabled, error, fetching, items],
  );
}
