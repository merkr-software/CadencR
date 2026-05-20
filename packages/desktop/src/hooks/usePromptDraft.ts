/**
 * Hook for persisting per-agent-session draft prompt text.
 * Uses WebSocket when wsSessionId is provided, falls back to HTTP.
 * Fetches saved draft on mount to restore after navigation.
 * Debounces saves (500ms) and flushes on unmount.
 */

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useWsSessionStore } from "@/stores/ws-session-store";
import { useSaveSessionDraft, useGetSessionDraft } from "@/api/generated";
import { createDraftGet, createDraftSave } from "@/lib/ws-envelope";

interface UsePromptDraftOptions {
  /** DB session ID when known; ws-session can also derive it from serverSessionId. */
  sessionId: number | undefined;
  /** WS store key — when provided, derives DB session ID from serverSessionId. */
  wsSessionId?: string | undefined;
  initialDraft: string | null;
}

interface DraftResultPayload {
  draft: string | null;
}

const localDrafts = new Map<string, string | null>();
const dirtyDraftScopes = new Set<string>();

export function resetPromptDraftMemoryForTest(): void {
  localDrafts.clear();
  dirtyDraftScopes.clear();
}

function draftScope(sessionId: number | undefined, wsSessionId: string | undefined): string | null {
  if (wsSessionId) return `ws:${wsSessionId}`;
  return sessionId != null ? `http:${sessionId}` : null;
}

function draftForScope(scope: string | null, fallback: string | null): string | null {
  return scope && localDrafts.has(scope) ? (localDrafts.get(scope) ?? null) : fallback;
}

function cacheDraft(scope: string | null, draft: string | null, dirty: boolean): void {
  if (!scope) return;
  localDrafts.set(scope, draft);
  if (dirty) dirtyDraftScopes.add(scope);
}

export function usePromptDraft({ sessionId, wsSessionId, initialDraft }: UsePromptDraftOptions) {
  const sendRaw = useWsSessionStore((s) => s.send);
  const sendRequest = useWsSessionStore((s) => s.sendRequest);
  const isConnected = useWsSessionStore((s) =>
    wsSessionId ? (s.sessions[wsSessionId]?.isConnected ?? false) : false,
  );
  const wsDbSessionId = useWsSessionStore((s) =>
    wsSessionId ? (s.sessions[wsSessionId]?.sessionDbId ?? undefined) : undefined,
  );
  const saveDraftMutation = useSaveSessionDraft();

  // Resolve the DB session ID from the WS store when available, or fall back to prop.
  const dbSessionId = useMemo(() => wsDbSessionId ?? sessionId, [wsDbSessionId, sessionId]);

  // For HTTP-path agents, fetch the draft from DB on mount
  const httpDraftQuery = useGetSessionDraft(sessionId ?? 0, {
    query: { enabled: !wsSessionId && !!sessionId },
  });

  const restoreScope = draftScope(sessionId, wsSessionId);
  const [restoredDraft, setRestoredDraft] = useState<string | null>(() =>
    draftForScope(restoreScope, initialDraft),
  );

  useEffect(() => {
    setRestoredDraft(draftForScope(restoreScope, initialDraft));
  }, [initialDraft, restoreScope]);

  // Sync HTTP draft query result
  useEffect(() => {
    if (!wsSessionId && httpDraftQuery.data) {
      setRestoredDraft(draftForScope(restoreScope, httpDraftQuery.data.draftPrompt ?? null));
    }
  }, [restoreScope, wsSessionId, httpDraftQuery.data]);

  const pendingRef = useRef<string | null | undefined>(undefined);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dbSessionIdRef = useRef(dbSessionId);
  dbSessionIdRef.current = dbSessionId;
  const wsSessionIdRef = useRef(wsSessionId);
  wsSessionIdRef.current = wsSessionId;
  const restoreScopeRef = useRef(restoreScope);
  restoreScopeRef.current = restoreScope;

  // Fetch draft from DB via WS on mount when session is initialized
  useEffect(() => {
    if (initialDraft != null || !wsSessionId || !isConnected || !dbSessionId) return;
    let cancelled = false;
    void sendRequest(wsSessionId, createDraftGet(dbSessionId))
      .then((payload) => {
        if (cancelled) return;
        const data = payload as DraftResultPayload;
        if (!restoreScope || !dirtyDraftScopes.has(restoreScope)) {
          setRestoredDraft(data.draft);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [initialDraft, restoreScope, wsSessionId, isConnected, dbSessionId, sendRequest]);

  const flushSave = useCallback(() => {
    if (pendingRef.current === undefined) return;
    const sid = dbSessionIdRef.current;
    if (!sid) {
      return;
    }
    const draft = pendingRef.current;
    pendingRef.current = undefined;
    if (restoreScopeRef.current) {
      dirtyDraftScopes.delete(restoreScopeRef.current);
    }

    const wsSid = wsSessionIdRef.current;
    if (wsSid) {
      sendRaw(wsSid, createDraftSave(sid, draft));
    } else {
      saveDraftMutation.mutate({ sessionId: sid, data: { draft } });
    }
  }, [sendRaw, saveDraftMutation]);

  // Flush on unmount or dbSessionId change
  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      flushSave();
    };
  }, [dbSessionId, flushSave]);

  useEffect(() => {
    if (!dbSessionId || !restoreScope || !dirtyDraftScopes.has(restoreScope)) return;
    if (pendingRef.current === undefined) {
      pendingRef.current = localDrafts.get(restoreScope);
    }
    flushSave();
  }, [dbSessionId, flushSave, restoreScope]);

  const saveDraft = useCallback(
    (text: string | null) => {
      cacheDraft(restoreScope, text, true);
      pendingRef.current = text;
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        flushSave();
      }, 500);
    },
    [flushSave, restoreScope],
  );

  return { initialDraft: restoredDraft, saveDraft };
}
