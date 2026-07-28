/**
 * Hook for per-project prompt history navigation (Up/Down arrow keys).
 * History is shared across all agents in a project and persisted to SQLite via WebSocket.
 */

import { useState, useCallback, useMemo, useRef, useEffect } from "react";
import { useWsSessionStore } from "@/stores/ws-session-store";
import { createHistoryGet, createHistoryAdd } from "@/lib/ws-envelope";

interface HistoryResultPayload {
  entries: string[];
}

function useHistoryNavigation(history: string[]) {
  const historyRef = useRef(history);
  historyRef.current = history;
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [tempDraft, setTempDraft] = useState("");
  const tempDraftRef = useRef(tempDraft);
  tempDraftRef.current = tempDraft;
  const historyIndexRef = useRef(historyIndex);
  historyIndexRef.current = historyIndex;

  const navigateUp = useCallback((currentText: string): string | null => {
    const entries = historyRef.current;
    const index = historyIndexRef.current;
    if (entries.length === 0) return null;
    if (index === -1) {
      setTempDraft(currentText);
      setHistoryIndex(0);
      return entries[0] ?? null;
    }
    if (index >= entries.length - 1) return null;
    const next = index + 1;
    setHistoryIndex(next);
    return entries[next] ?? null;
  }, []);

  const navigateDown = useCallback((): string | null => {
    const entries = historyRef.current;
    const index = historyIndexRef.current;
    if (index === -1) return null;
    if (index > 0) {
      const previous = index - 1;
      setHistoryIndex(previous);
      return entries[previous] ?? null;
    }
    setHistoryIndex(-1);
    return tempDraftRef.current;
  }, []);

  const resetNavigation = useCallback(() => {
    if (historyIndexRef.current === -1) return;
    setHistoryIndex(-1);
    setTempDraft("");
  }, []);

  const clearNavigation = useCallback(() => {
    setHistoryIndex(-1);
    setTempDraft("");
  }, []);

  return useMemo(
    () => ({ navigateUp, navigateDown, resetNavigation, clearNavigation, historyIndex }),
    [clearNavigation, historyIndex, navigateDown, navigateUp, resetNavigation],
  );
}

export function usePromptHistory(projectId: number, wsSessionId?: string) {
  const sendRequest = useWsSessionStore((s) => s.sendRequest);
  const isConnected = useWsSessionStore((s) =>
    wsSessionId ? (s.sessions[wsSessionId]?.isConnected ?? false) : false,
  );

  const [history, setHistory] = useState<string[]>([]);
  const navigation = useHistoryNavigation(history);

  // Fetch history when WS connects
  useEffect(() => {
    if (!wsSessionId || !projectId || !isConnected) return;
    void sendRequest(wsSessionId, createHistoryGet(projectId)).then((payload) => {
      const data = payload as HistoryResultPayload | null;
      if (data) setHistory(data.entries ?? []);
    });
  }, [wsSessionId, projectId, isConnected, sendRequest]);

  const addEntry = useCallback(
    (content: string) => {
      if (!content.trim() || !wsSessionId || !projectId) return;
      const trimmed = content.trim();
      void sendRequest(wsSessionId, createHistoryAdd(projectId, trimmed)).then((payload) => {
        const data = payload as { added: boolean } | null;
        if (data?.added) {
          setHistory((prev) => [trimmed, ...prev].slice(0, 100));
        }
      });
      navigation.clearNavigation();
    },
    [navigation, projectId, sendRequest, wsSessionId],
  );

  return useMemo(
    () => ({
      navigateUp: navigation.navigateUp,
      navigateDown: navigation.navigateDown,
      addEntry,
      resetNavigation: navigation.resetNavigation,
      historyIndex: navigation.historyIndex,
    }),
    [addEntry, navigation],
  );
}
