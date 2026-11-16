import { memo, type ReactElement, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2Icon } from "lucide-react";

import {
  getPluginTabActivityQueryKey,
  usePluginTabActivity,
  usePluginTabStopBackend,
  type PluginTabSummary,
} from "@/api/generated";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { apiErrorMessage, toastError } from "@/lib/api-errors";
import {
  setPluginTabActivityOpen,
  usePluginTabRuntimeStore,
} from "@/lib/plugin-tabs/runtime-store";

import { PluginTabAccessBadge } from "./PluginTabAccess";
import { ActivitySection, BackendPanel, CommandList } from "./PluginTabActivitySections";
import { PluginTabIcon } from "./PluginTabIcon";
import { ACCESS_LEVEL_COPY, backendBinaries } from "./plugin-tab-access";

/** Refetch while open: commands and the backend move on their own. */
const REFRESH_MS = 2000;

/**
 * What a custom tab ran in this conversation: the commands Cadencr ran for
 * it and its native backend, with the backend's log and a Stop control.
 * Opened from the "+" menu's **Activity…**; one per tab instance. The dialog
 * hides native views while open, so the guest can't cover it. Memoized: it
 * stays mounted in every kept-alive tab, hidden ones included.
 */
export const PluginTabActivityDialog = memo(function PluginTabActivityDialog({
  instanceId,
  featureId,
  summary,
}: {
  instanceId: string;
  featureId: number;
  summary: PluginTabSummary;
}): ReactNode {
  const open = usePluginTabRuntimeStore((state) => state.activityOpen === instanceId);
  if (!open) return null;
  return (
    <Dialog open onOpenChange={(next) => !next && setPluginTabActivityOpen(null)}>
      <DialogContent className="gap-0 p-0 sm:max-w-xl">
        <DialogHeader className="border-b border-border px-6 py-4">
          <div className="flex items-center gap-3">
            <span className="grid size-8 shrink-0 place-items-center rounded-md bg-muted text-foreground">
              <PluginTabIcon svg={summary.icon_svg} />
            </span>
            <DialogTitle className="text-base font-semibold">{summary.name} activity</DialogTitle>
            <PluginTabAccessBadge level={summary.access_level} />
          </div>
          <DialogDescription className="text-xs">
            {ACCESS_LEVEL_COPY[summary.access_level].summary} Shown for this conversation since
            Cadencr started.
          </DialogDescription>
        </DialogHeader>
        <ActivityBody featureId={featureId} summary={summary} />
      </DialogContent>
    </Dialog>
  );
});

function ActivityBody({
  featureId,
  summary,
}: {
  featureId: number;
  summary: PluginTabSummary;
}): ReactElement {
  const queryClient = useQueryClient();
  const params = { feature_id: featureId };
  const activity = usePluginTabActivity(summary.id, params, {
    query: { refetchInterval: REFRESH_MS },
  });
  const stop = usePluginTabStopBackend({
    mutation: {
      onSuccess: () =>
        queryClient.invalidateQueries({
          queryKey: getPluginTabActivityQueryKey(summary.id, params),
        }),
      onError: (error) => toastError(error, "The backend could not be stopped"),
    },
  });
  if (activity.isPending) {
    return (
      <p role="status" className="flex items-center gap-2 px-6 py-6 text-xs text-muted-foreground">
        <Loader2Icon className="size-3.5 animate-spin" aria-hidden />
        Loading activity…
      </p>
    );
  }
  if (activity.isError) {
    return (
      <p role="alert" className="px-6 py-6 text-xs text-destructive">
        {apiErrorMessage(activity.error, "The tab's activity could not be loaded")}
      </p>
    );
  }
  return (
    <div className="max-h-[calc(var(--app-vh)*0.6)] space-y-5 overflow-y-auto px-6 py-4">
      {summary.commands.length > 0 ? (
        <ActivitySection title="Commands">
          <CommandList records={activity.data.commands} />
        </ActivitySection>
      ) : null}
      {summary.backend ? (
        <ActivitySection title="Native backend">
          <p className="break-all font-mono text-[11.5px] text-muted-foreground">
            {backendBinaries(summary.backend)}
          </p>
          <BackendPanel
            status={activity.data.backend}
            stopping={stop.isPending}
            onStop={() => stop.mutate({ id: summary.id, featureId })}
          />
        </ActivitySection>
      ) : null}
    </div>
  );
}
