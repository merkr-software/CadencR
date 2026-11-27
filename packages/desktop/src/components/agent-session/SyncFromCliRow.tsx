import { translateUi, useUiTranslation } from "@/lib/i18n/ui";
import { type ReactElement } from "react";
import { Loader2Icon, RefreshCwIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useRefreshSession } from "@/api/generated";
import { apiErrorMessage } from "@/lib/api-errors";
import { useWsSessionStore } from "@/stores/ws-session-store";

interface SyncFromCliRowProps {
  /** Feature (conversation) id — target of the refresh endpoint. */
  featureId: number;
  /** WS store key — used to merge the synced events into the live conversation. */
  wsSessionId: string;
  isRunning: boolean;
}

/**
 * Button in the Session Info popover that pulls events a user added by
 * continuing this session in the provider's CLI. Hits the refresh endpoint
 * (which appends newer on-disk events to the session), then merges the new
 * rows into the live conversation via the same catch-up path as WS reconnect.
 */
export function SyncFromCliRow({
  featureId,
  wsSessionId,
  isRunning,
}: SyncFromCliRowProps): ReactElement {
  const { t } = useUiTranslation();
  const refresh = useRefreshSession({
    mutation: {
      onSuccess: async ({ added, session_db_id, cursor }) => {
        if (added > 0) {
          // Pull exactly the rows the backend appended (`id > cursor`) into the
          // live conversation, keyed by the authoritative session id. Read the
          // action via getState() — it drives no UI, so the row needn't
          // subscribe to the store.
          await useWsSessionStore.getState().refreshSessionMessages(wsSessionId, {
            featureId,
            sessionDbId: session_db_id,
            cursor,
          });
        }
        toast.success(
          added > 0
            ? translateUi("conversation.stream.syncFromCliRow.syncResult", {
                count: added,
                defaultValue_one: "Synced {{count}} event from the CLI",
                defaultValue_other: "Synced {{count}} events from the CLI",
              })
            : translateUi(
                "conversation.stream.syncFromCliRow.alreadyUpToDate",
                "Already up to date",
              ),
        );
      },
      onError: (err) => {
        toast.error(
          apiErrorMessage(
            err,
            translateUi(
              "conversation.stream.syncFromCliRow.failedToSyncFromTheCli",
              "Failed to sync from the CLI",
            ),
          ),
        );
      },
    },
  });
  const pending = refresh.isPending;

  return (
    <div className="space-y-1">
      <Button
        type="button"
        variant="raised"
        size="sm"
        className="w-full"
        onClick={() => refresh.mutate({ featureId })}
        disabled={isRunning || pending}
      >
        {pending ? <Loader2Icon className="animate-spin" /> : <RefreshCwIcon />}
        {pending
          ? t("conversation.stream.syncFromCliRow.syncing", "Syncing…")
          : t("conversation.stream.syncFromCliRow.syncFromCli", "Sync from CLI")}
      </Button>
      <p className="text-[11px] text-muted-foreground">
        {isRunning
          ? t(
              "conversation.stream.syncFromCliRow.pauseTheAgentToPullInEvents",
              "Pause the agent to pull in events from the CLI.",
            )
          : t(
              "conversation.stream.syncFromCliRow.pullInEventsAddedWhileYouContinued",
              "Pull in events added while you continued this session in the CLI.",
            )}
      </p>
    </div>
  );
}
