import { useCallback } from "react";
import { toast } from "sonner";
import { useKillTerminalSessions } from "@/api/generated";
import { apiErrorMessage } from "@/lib/api-errors";
import { desktopBridge } from "@/lib/desktop-bridge";
import { closeFeatureActivityNoun } from "@/lib/feature-activity-close";
import { useTerminalStore } from "@/hooks/useTerminalState";

export interface CloseFeatureActivityArgs {
  featureId: number;
  shellCount: number;
  browserCount: number;
}

/**
 * Tear down a feature's live activity from the sidebar without opening it:
 * kill its running shells (POST /api/terminal/kill) and close its browser tabs
 * (Electron `closeBrowserTabsForScope`, where the browser scope id is the
 * feature id). Counts are passed in by the caller so the returned callback
 * stays referentially stable across the sidebar's 2s activity polling.
 */
export function useCloseFeatureActivity(): (args: CloseFeatureActivityArgs) => void {
  const { mutateAsync: killTerminals } = useKillTerminalSessions();
  return useCallback(
    ({ featureId, shellCount, browserCount }: CloseFeatureActivityArgs): void => {
      if (shellCount <= 0 && browserCount <= 0) return;
      const noun = closeFeatureActivityNoun(shellCount, browserCount);
      const work = (async (): Promise<void> => {
        if (shellCount > 0) {
          await killTerminals({ params: { feature_id: featureId } });
          // Tear down the now-dead panes. Without this an open terminal tab is
          // left attached to its hung-up shell (the "zsh: jobs SIGHUPed",
          // can't-type state); clearing it lets a fresh shell spawn cleanly.
          useTerminalStore.getState().closePanel(featureId);
        }
        if (browserCount > 0) await desktopBridge.closeBrowserTabsForScope(featureId);
      })();
      toast.promise(work, {
        loading: `Closing ${noun}…`,
        success: `Closed ${noun}.`,
        error: (err) => apiErrorMessage(err, `Failed to close ${noun}`),
      });
    },
    [killTerminals],
  );
}
