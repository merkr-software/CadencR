import { translateUi } from "@/lib/i18n/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useEditorStore } from "@/stores/editor-store";
import { browserTabCount } from "@/stores/browser-store";
import { useTerminalStore } from "@/hooks/useTerminalState";
import { getFocusedTabForFeature } from "@/lib/feature-focus-handoff";
import { isReplacementShown } from "@/lib/plugin-tabs/builtin-fallback";
import { useGlobalShortcutById } from "@/hooks/useShortcut";
import { getActiveCloseWork, type ActiveCloseWork } from "@/api/generated";
import { desktopBridge } from "@/lib/desktop-bridge";
import type { AppCloseRequest } from "@/shared/app-close";

const CLOSE_ERROR_TOAST_ID = "app-close:error";
const CLOSE_LOADING_TOAST_ID = "app-close:loading";
const CLOSE_CONFIRM_TOAST_ID = "app-close:confirm";

function reportCloseFailure(error: unknown): void {
  toast.error(translateUi("shell.close.failure", "Could not close Cadencr"), {
    id: CLOSE_ERROR_TOAST_ID,
    description: error instanceof Error ? error.message : String(error),
  });
}

function confirmClose(request: AppCloseRequest): Promise<void> {
  toast.loading(
    request.quitting
      ? translateUi("shell.close.stoppingAgents", "Stopping agents…")
      : translateUi("shell.close.closingWindow", "Closing the window…"),
    { id: CLOSE_CONFIRM_TOAST_ID },
  );
  return desktopBridge
    .confirmClose(request.id)
    .catch(reportCloseFailure)
    .finally(() => toast.dismiss(CLOSE_CONFIRM_TOAST_ID));
}

// True when the focused tab in `featureId` still owns ⌘W — i.e. there's
// something for the editor/terminal sibling handler to close. In that case
// the app-close fallback bails so the sibling handler can take the chord.
// Exported for testing; production callers use it via the ⌘W handler below.
export function shouldBypassAppClose(featureId: number | null): boolean {
  if (featureId == null) return false;
  const focusedTab = getFocusedTabForFeature(featureId);
  // A custom tab holding the built-in's place has no sibling ⌘W handler.
  if (focusedTab && isReplacementShown(featureId, focusedTab)) return false;
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

export interface AppCloseState {
  /** The close waiting on the user's confirmation, or `null`. */
  request: AppCloseRequest | null;
  /** Null when the service could not list the active work. */
  agents: ActiveCloseWork[] | null;
  cancel: () => void;
  close: () => void;
}

export function useAppClose(activeFeatureId: number | null) {
  const [request, setRequest] = useState<AppCloseRequest | null>(null);
  const [agents, setAgents] = useState<ActiveCloseWork[] | null>(null);
  const lookup = useRef<AbortController | null>(null);

  const requestClose = useCallback((next: AppCloseRequest) => {
    lookup.current?.abort();
    const controller = new AbortController();
    lookup.current = controller;
    setRequest(null);
    toast.loading(translateUi("shell.close.checkingAgents", "Checking for active agents…"), {
      id: CLOSE_LOADING_TOAST_ID,
    });
    const showDialog = (working: ActiveCloseWork[] | null): void => {
      if (controller.signal.aborted) return;
      setAgents(working);
      setRequest(next);
      desktopBridge.acknowledgeCloseRequest(next.id).catch(reportCloseFailure);
    };
    void getActiveCloseWork(AbortSignal.any([controller.signal, AbortSignal.timeout(2_000)]))
      .then(
        (working) => {
          if (controller.signal.aborted) return;
          if (working.length > 0) showDialog(working);
          else return confirmClose(next);
        },
        () => showDialog(null),
      )
      .finally(() => {
        if (lookup.current === controller) {
          lookup.current = null;
          toast.dismiss(CLOSE_LOADING_TOAST_ID);
        }
      });
  }, []);

  const cancel = useCallback(() => {
    if (!request) return;
    setRequest(null);
    desktopBridge.cancelClose(request.id).catch(reportCloseFailure);
  }, [request]);

  const close = useCallback(() => {
    if (!request) return;
    setRequest(null);
    void confirmClose(request);
  }, [request]);

  useEffect(() => {
    const unsubscribe = desktopBridge.onCloseRequested(requestClose);
    return () => {
      unsubscribe();
      lookup.current?.abort();
    };
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
