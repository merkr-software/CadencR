import { translateUi } from "@/lib/i18n/ui";
import { useCallback } from "react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { getListFeatureActivityQueryKey, useKillTerminalSessions } from "@/api/generated";
import { apiErrorMessage } from "@/lib/api-errors";
import { desktopBridge, isDesktopShell } from "@/lib/desktop-bridge";
import { closeFeatureActivityNoun } from "@/lib/feature-activity-close";
import { useTerminalStore } from "@/hooks/useTerminalState";

export interface CloseFeatureActivityArgs {
  projectId: number;
  featureId: number;
  shellCount: number;
  browserCount: number;
  downloadCount: number;
}

/**
 * Tear down a feature's live activity from the sidebar without opening it:
 * kill its running shells (POST /api/terminal/kill) and close its browser tabs
 * (Electron `closeBrowserTabsForScope`, where the browser scope id is the
 * feature id). Counts are passed in by the caller so the returned callback
 * stays referentially stable across the sidebar's activity polling.
 */
export function useCloseFeatureActivity(): (args: CloseFeatureActivityArgs) => void {
  const { mutateAsync: killTerminals } = useKillTerminalSessions();
  const queryClient = useQueryClient();
  return useCallback(
    ({
      projectId,
      featureId,
      shellCount,
      browserCount,
      downloadCount,
    }: CloseFeatureActivityArgs): void => {
      if (!isDesktopShell()) {
        browserCount = 0;
        downloadCount = 0;
      }
      if (shellCount <= 0 && browserCount <= 0 && downloadCount <= 0) return;
      const noun = closeFeatureActivityNoun(shellCount, browserCount, downloadCount);
      const work = (async (): Promise<void> => {
        if (shellCount > 0) {
          await killTerminals({ params: { feature_id: featureId } });
          // Tear down the now-dead panes. Without this an open terminal tab is
          // left attached to its hung-up shell (the "zsh: jobs SIGHUPed",
          // can't-type state); clearing it lets a fresh shell spawn cleanly.
          useTerminalStore.getState().closePanel(featureId);
          // The sidebar badge derives from `list_feature_activity` (now polled
          // only every 10s), so refresh this project's query immediately — but
          // fire-and-forget, since the success toast shouldn't wait on the poll.
          void queryClient.invalidateQueries({
            queryKey: getListFeatureActivityQueryKey({
              project_id: projectId,
              include_archived: true,
            }),
          });
        }
        if (browserCount > 0 || downloadCount > 0) {
          await desktopBridge.closeBrowserTabsForScope(featureId);
        }
      })();
      toast.promise(work, {
        loading: translateUi("sidebar.activity.closing", "Closing {{activity}}…", {
          activity: noun,
        }),
        success: translateUi("sidebar.activity.closed", "Closed {{activity}}.", { activity: noun }),
        error: (err) =>
          apiErrorMessage(
            err,
            translateUi("sidebar.activity.closeFailed", "Failed to close {{activity}}", {
              activity: noun,
            }),
          ),
      });
    },
    [killTerminals, queryClient],
  );
}
