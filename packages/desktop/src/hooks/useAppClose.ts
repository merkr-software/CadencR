import { useCallback, useEffect, useMemo, useState } from "react";
import type { QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useWsSessionStore } from "@/stores/ws-session-store";
import { stopUnloadedAgents } from "@/stores/unloaded-agent-control";
import { busySessionTargets, TURN_IN_PROGRESS } from "@/stores/busy-session-targets";
import { useEditorStore } from "@/stores/editor-store";
import { browserTabCount } from "@/stores/browser-store";
import { useTerminalStore } from "@/hooks/useTerminalState";
import { getFocusedTabForFeature } from "@/lib/feature-focus-handoff";
import { useGlobalShortcutById } from "@/hooks/useShortcut";
import { getListFeaturesQueryKey } from "@/api/generated";
import { desktopBridge } from "@/lib/desktop-bridge";
import type { AppCloseChoice, AppCloseRequest } from "@/shared/app-close";
import { useSessionStatusStore } from "@/stores/session-status-store";

const CLOSE_ERROR_TOAST_ID = "app-close:error";

function reportCloseFailure(error: unknown): void {
  toast.error("Could not close Cadencr", {
    id: CLOSE_ERROR_TOAST_ID,
    description: error instanceof Error ? error.message : String(error),
  });
}

function lookupFeatureTitle(featureId: number | null, queryClient: QueryClient): string | null {
  if (!featureId) return null;
  for (const [, data] of queryClient.getQueriesData<{ id: number; title: string }[]>({
    queryKey: getListFeaturesQueryKey(),
  })) {
    const feature = data?.find((f) => f.id === featureId);
    if (feature) return feature.title;
  }
  return null;
}

// True when the focused tab in `featureId` still owns ⌘W — i.e. there's
// something for the editor/terminal sibling handler to close. In that case
// the app-close fallback bails so the sibling handler can take the chord.
// Exported for testing; production callers use it via the ⌘W handler below.
export function shouldBypassAppClose(featureId: number | null): boolean {
  if (featureId == null) return false;
  const focusedTab = getFocusedTabForFeature(featureId);
  if (focusedTab === "editor") {
    const panes = useEditorStore.getState().features[featureId]?.panes ?? {};
    return Object.values(panes).some((p) => p.tabs.length > 0);
  }
  if (focusedTab === "terminal") {
    return useTerminalStore.getState().features[featureId]?.root != null;
  }
  if (focusedTab === "browser") {
    // ⌘W closes the focused browser tab while any exist; only an empty
    // browser surface lets the chord fall through to close the window.
    return browserTabCount() > 0;
  }
  return false;
}

/** An agent mid-turn when the user asked to close, on any device. */
export interface WorkingAgent {
  sessionId: number;
  label: string;
  /** Mid-turn but blocked on a question or permission request. */
  waitingOnYou: boolean;
}

function getWorkingAgents(queryClient: QueryClient): WorkingAgent[] {
  const agents: WorkingAgent[] = [];
  for (const [sessionId, entry] of Object.entries(useSessionStatusStore.getState().bySession)) {
    if (entry.status === "idle") continue;
    agents.push({
      sessionId: Number(sessionId),
      label: lookupFeatureTitle(entry.featureId, queryClient) ?? "Untitled conversation",
      waitingOnYou: entry.status === "question",
    });
  }
  return agents;
}

/**
 * The dev service outlives the app, so quitting cannot leave its agents
 * stopped the way a packaged build does (`setShutdownIntent`): stop them
 * instead. Which agents are working comes from the backend's status book, so
 * one started by a schedule, MCP or another device counts too: those with a
 * conversation open here are stopped over its socket, the others over HTTP.
 */
export function interruptDevAgents(isDev: boolean = import.meta.env.DEV): boolean {
  if (!isDev) return false;
  const wsStore = useWsSessionStore.getState();
  const { loaded, unreachable } = busySessionTargets(TURN_IN_PROGRESS);
  for (const sessionId of loaded) wsStore.interrupt(sessionId);
  void stopUnloadedAgents(unreachable);
  return loaded.length > 0 || unreachable.length > 0;
}

export interface AppCloseState {
  /** The close waiting on the user's confirmation, or `null`. */
  request: AppCloseRequest | null;
  agents: WorkingAgent[];
  cancel: () => void;
  close: (choice: AppCloseChoice) => void;
}

export function useAppClose(queryClient: QueryClient, activeFeatureId: number | null) {
  const [request, setRequest] = useState<AppCloseRequest | null>(null);
  const [agents, setAgents] = useState<WorkingAgent[]>([]);

  // X button, ⌘Q, ⌘W, the Dock: the main process asks, and owns whether the
  // answer closes the window or quits. It waits on the user only once told
  // the confirmation is on screen; otherwise it closes without it.
  const requestClose = useCallback(
    (next: AppCloseRequest) => {
      const working = getWorkingAgents(queryClient);
      if (working.length === 0) {
        desktopBridge.confirmClose().catch(reportCloseFailure);
        return;
      }
      setAgents(working);
      setRequest(next);
      desktopBridge.acknowledgeCloseRequest().catch(reportCloseFailure);
    },
    [queryClient],
  );

  const cancel = useCallback(() => {
    setRequest(null);
    desktopBridge.cancelClose().catch(reportCloseFailure);
  }, []);

  const close = useCallback((choice: AppCloseChoice) => {
    setRequest(null);
    const confirm = (): void => {
      desktopBridge.confirmClose(choice).catch(reportCloseFailure);
    };
    if (!choice.resumeAgents && interruptDevAgents()) {
      // Let the interrupts reach the service before the window goes away.
      setTimeout(confirm, 300);
      return;
    }
    confirm();
  }, []);

  useEffect(() => {
    return desktopBridge.onCloseRequested(requestClose);
  }, [requestClose]);

  // CMD+Q → quit the app. This must go through Electron's quit path so
  // `before-quit` runs and the production sidecar is stopped.
  useGlobalShortcutById("quit", (e) => {
    e.preventDefault();
    desktopBridge.requestQuit().catch(reportCloseFailure);
  });

  // ⌘W / Ctrl+W → close the window when nothing else owns the chord. The
  // editor/terminal sibling handlers take ⌘W on their own tabs; this is
  // the "I'm on an empty editor / non-owning tab, ⌘W should close the
  // window" fallback. Scoping the bypass to the *focused tab's* owning
  // surface (not the whole feature) is intentional — see registry entry.
  // It closes the window like its button does: main decides whether that
  // quits (everywhere but macOS) and asks back through `onCloseRequested`.
  // Off the shell there is no window to close; the browser keeps the chord.
  useGlobalShortcutById("app-close", (e) => {
    if (!desktopBridge.isElectron || shouldBypassAppClose(activeFeatureId)) return;
    e.preventDefault();
    desktopBridge.windowClose?.().catch(reportCloseFailure);
  });

  return useMemo<AppCloseState>(
    () => ({ request, agents, cancel, close }),
    [request, agents, cancel, close],
  );
}
