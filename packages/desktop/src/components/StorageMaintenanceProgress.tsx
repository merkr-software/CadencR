import { formatExactNumber, formatPercent } from "@/lib/format-number";
import { formattingLocale } from "@/lib/i18n/formatting-locale";
import { useUiTranslation, type UiTranslator } from "@/lib/i18n/ui";
import { ProgressBar } from "@/components/ui/progress-bar";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  useStorageMaintenanceStore,
  type StorageMaintenanceStatus,
} from "@/stores/storage-maintenance-store";

function statusLabel(t: UiTranslator, status: StorageMaintenanceStatus): string {
  if (status.task === "unknown")
    return t(
      "system.storageMaintenanceProgress.storageStatusUnavailable",
      "Storage status unavailable",
    );
  if (status.task === "cleanup") {
    if (status.phase === "completed")
      return t(
        "system.storageMaintenanceProgress.cleanupComplete",
        "Conversation cleanup complete",
      );
    if (status.phase === "cancelled")
      return t("system.storageMaintenanceProgress.cleanupPaused", "Conversation cleanup paused");
    if (status.phase === "failed")
      return t("system.storageMaintenanceProgress.cleanupRetry", "Conversation cleanup will retry");
    return t("system.storageMaintenanceProgress.cleanupActive", "Cleaning archived conversations");
  }
  if (status.phase === "completed")
    return t(
      "system.storageMaintenanceProgress.optimizationComplete",
      "Storage optimization complete",
    );
  if (status.phase === "cancelled")
    return t("system.storageMaintenanceProgress.optimizationPaused", "Storage optimization paused");
  if (status.phase === "failed")
    return t(
      "system.storageMaintenanceProgress.optimizationRetry",
      "Storage optimization will retry",
    );
  return t("system.storageMaintenanceProgress.optimizationActive", "Optimizing storage");
}

function formatProgress(status: StorageMaintenanceStatus, locale: string): string {
  const ratio = status.total > 0 ? status.completed / status.total : 0;
  return formatPercent(ratio, locale);
}

function progressDescription(
  t: UiTranslator,
  status: StorageMaintenanceStatus,
  percent: string,
  locale: string,
): string {
  if (status.task !== "cleanup")
    return t("system.storage.progress", "Progress: {{percent}}.", { percent });

  const values = {
    count: status.total,
    formattedCount: formatExactNumber(status.total, locale),
    completed: formatExactNumber(status.completed, locale),
  };
  switch (status.phase) {
    case "completed":
      return t(
        "system.storage.progressCompleted",
        "Completed {{completed}} of {{formattedCount}} archived conversations.",
        {
          ...values,
          defaultValue_zero:
            "Completed {{completed}} of {{formattedCount}} archived conversations.",
          defaultValue_one: "Completed {{completed}} of {{formattedCount}} archived conversation.",
          defaultValue_other:
            "Completed {{completed}} of {{formattedCount}} archived conversations.",
        },
      );
    case "cancelled":
      return t(
        "system.storage.progressPaused",
        "Paused safely after {{completed}} of {{formattedCount}} archived conversations.",
        {
          ...values,
          defaultValue_zero:
            "Paused safely after {{completed}} of {{formattedCount}} archived conversations.",
          defaultValue_one:
            "Paused safely after {{completed}} of {{formattedCount}} archived conversation.",
          defaultValue_other:
            "Paused safely after {{completed}} of {{formattedCount}} archived conversations.",
        },
      );
    case "failed":
      return t(
        "system.storage.progressStopped",
        "Stopped safely after {{completed}} of {{formattedCount}} archived conversations. It will retry automatically, or you can run it from Settings.",
        {
          ...values,
          defaultValue_zero:
            "Stopped safely after {{completed}} of {{formattedCount}} archived conversations. It will retry automatically, or you can run it from Settings.",
          defaultValue_one:
            "Stopped safely after {{completed}} of {{formattedCount}} archived conversation. It will retry automatically, or you can run it from Settings.",
          defaultValue_other:
            "Stopped safely after {{completed}} of {{formattedCount}} archived conversations. It will retry automatically, or you can run it from Settings.",
        },
      );
    default:
      return t(
        "system.storage.progressProcessed",
        "Processed {{completed}} of {{formattedCount}} archived conversations.",
        {
          ...values,
          defaultValue_zero:
            "Processed {{completed}} of {{formattedCount}} archived conversations.",
          defaultValue_one: "Processed {{completed}} of {{formattedCount}} archived conversation.",
          defaultValue_other:
            "Processed {{completed}} of {{formattedCount}} archived conversations.",
        },
      );
  }
}

function MaintenanceExplanation({
  status,
  percent,
}: {
  status: StorageMaintenanceStatus;
  percent: string;
}): React.JSX.Element {
  const { t, i18n } = useUiTranslation();
  const locale = formattingLocale(i18n.language);
  if (status.task === "cleanup") {
    return (
      <>
        <p className="font-semibold text-popover-foreground">
          {t(
            "system.storageMaintenanceProgress.archivedConversationCleanup",
            "Archived conversation cleanup",
          )}
        </p>
        <p>{progressDescription(t, status, percent, locale)}</p>
        <p>
          <strong className="font-semibold text-popover-foreground">
            {t(
              "system.storageMaintenanceProgress.youCanKeepUsingCadencrNormallyWhile",
              "You can keep using Cadencr normally while cleanup runs.",
            )}
          </strong>
        </p>
        <p>
          {t(
            "system.storageMaintenanceProgress.onlyOldArchivedConversationsAreProcessedCadencr",
            "Only old archived conversations are processed. Cadencr shortens long command output to save space.",
          )}
        </p>
        <p>
          <strong className="font-semibold text-popover-foreground">
            {t(
              "system.storageMaintenanceProgress.noConversationsOrMessagesAreDeleted",
              "No conversations or messages are deleted.",
            )}
          </strong>{" "}
          {t("system.storage.messagesRetained", "Your messages and agent replies stay available.")}
        </p>
        <p>
          {t(
            "system.storageMaintenanceProgress.cleanupIsSafeAndResumableItPauses",
            "Cleanup is safe and resumable. It pauses if a conversation becomes active or your cleanup settings change. Saved space is reclaimed safely on a later startup.",
          )}
        </p>
      </>
    );
  }

  if (status.task === "optimization") {
    return <OptimizationExplanation progress={progressDescription(t, status, percent, locale)} />;
  }

  return (
    <>
      <p className="font-semibold text-popover-foreground">
        {t(
          "system.storageMaintenanceProgress.storageStatusUnavailable",
          "Storage status unavailable",
        )}
      </p>
      <p>
        {t(
          "system.storageMaintenanceProgress.cadencrCouldNotReadTheStorageMaintenance",
          "Cadencr could not read the storage maintenance update, so the exact operation cannot be shown. Check the service logs for details.",
        )}
      </p>
    </>
  );
}

function OptimizationExplanation({ progress }: { progress: string }): React.JSX.Element {
  const { t } = useUiTranslation();
  return (
    <>
      <p className="font-semibold text-popover-foreground">
        {t("system.storageMaintenanceProgress.storageOptimization", "Storage optimization")}
      </p>
      <p>{progress}</p>
      <p>
        <strong className="font-semibold text-popover-foreground">
          {t(
            "system.storageMaintenanceProgress.youCanKeepUsingCadencrNormallyWhileOptimizationRuns",
            "You can keep using Cadencr normally while optimization runs.",
          )}
        </strong>
      </p>
      <p>
        {t(
          "system.storageMaintenanceProgress.cadencrRemovesVerifiedDuplicateCommandOutputAnd",
          "Cadencr removes verified duplicate command output and moves pasted images to separate storage.",
        )}
      </p>
      <p>
        <strong className="font-semibold text-popover-foreground">
          {t(
            "system.storageMaintenanceProgress.noConversationInformationIsLost",
            "No conversation information is lost.",
          )}
        </strong>{" "}
        {t("system.storage.outputsRetained", "The retained output and images remain available.")}
      </p>
      <p>
        {t(
          "system.storageMaintenanceProgress.theWorkResumesAutomaticallyIfInterruptedSaved",
          "The work resumes automatically if interrupted. Saved space is reclaimed safely.",
        )}
      </p>
    </>
  );
}

export function StorageMaintenanceProgress(): React.JSX.Element | null {
  const { t, i18n } = useUiTranslation();
  const status = useStorageMaintenanceStore((state) => state.status);
  if (!status) return null;

  const label = statusLabel(t, status);
  const percent = formatProgress(status, formattingLocale(i18n.language));
  const indicatorClassName =
    status.phase === "completed"
      ? "bg-[var(--status-ip)]"
      : status.phase === "failed"
        ? "bg-destructive"
        : status.phase === "cancelled"
          ? "bg-muted-foreground"
          : "bg-[var(--acc-orange)]";

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <div
            role="status"
            aria-live="polite"
            tabIndex={0}
            className={cn(
              "w-[90%] cursor-help px-3 pb-1 text-[10px] text-muted-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring",
              status.phase === "failed" && "text-destructive",
            )}
          >
            <div className="mb-1 flex items-center justify-between gap-2">
              <span className="min-w-0 truncate">{label}</span>
              {status.total > 0 && <span className="shrink-0 tabular-nums">{percent}</span>}
            </div>
            <ProgressBar
              completed={status.completed}
              total={status.total}
              showCount={false}
              aria-label={label}
              indicatorClassName={indicatorClassName}
            />
          </div>
        </TooltipTrigger>
        <TooltipContent
          side="top"
          align="start"
          className="w-80 space-y-2 px-3 py-2.5 leading-relaxed"
        >
          <MaintenanceExplanation status={status} percent={percent} />
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
