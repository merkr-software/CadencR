import { translateUi, UiTrans, useUiTranslation } from "@/lib/i18n/ui";
import { useState } from "react";
import { ArrowUpCircle, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useDiscardManagedTabUpdate, type PluginTabSummary } from "@/api/generated";
import { reasonClause } from "@/components/plugin-tabs/plugin-tab-access";
import { WARNING_BANNER_CLASS } from "@/components/settings/SettingsWarningsBanner";
import { Button } from "@/components/ui/button";
import { apiErrorCode, toastError } from "@/lib/api-errors";
import { PLUGIN_TAB_ERROR } from "@/lib/plugin-tabs/error-codes";
import { refreshPluginTabsOrToast } from "@/lib/plugin-tabs/live-instances";
import { cn } from "@/lib/utils";

/**
 * A marketplace update staged beside the installed revision: it asks for
 * different permissions (or ships another backend binary), so it waits for
 * the user. Review opens the consent dialog on the update; "Keep current
 * version" discards it. The installed version keeps running either way.
 */
export function CustomTabUpdateNotice({
  tab,
  onReview,
  disabled = false,
  className,
}: {
  tab: PluginTabSummary;
  onReview: () => void;
  disabled?: boolean;
  className?: string;
}): React.JSX.Element | null {
  const { t } = useUiTranslation();
  const update = tab.pending_update;
  const discard = useDiscard(tab);
  if (!update) return null;
  return (
    <div
      role="status"
      className={cn(WARNING_BANNER_CLASS, "flex flex-wrap items-center gap-x-3 gap-y-2", className)}
    >
      <p className="flex min-w-0 flex-1 basis-56 items-start gap-2 text-xs text-muted-foreground">
        <ArrowUpCircle className="mt-px size-3.5 shrink-0 text-[var(--acc-orange)]" aria-hidden />
        {update.blocked_reason ? (
          // Accepting it is refused (PLUGIN_TAB_BLOCKED): only discarding it is offered.
          <span>
            <span className="font-medium text-destructive">
              <UiTrans
                i18nKey="customTabs.updateNotice.blocked"
                defaults="Update <version/> is blocked by Cadencr: <reason/>."
                components={{
                  version: <span className="font-mono">{update.version}</span>,
                  reason: <span>{reasonClause(update.blocked_reason)}</span>,
                }}
              />
            </span>{" "}
            {t("customTabs.updateNotice.blockedHint", "Keep the current version to dismiss it.")}
          </span>
        ) : (
          <ReadyText version={update.version} installed={tab.version} />
        )}
      </p>
      <span className="flex shrink-0 items-center gap-1.5">
        <Button
          type="button"
          size="xs"
          variant="ghost"
          disabled={disabled || discard.pending}
          onClick={() => void discard.run()}
        >
          {discard.pending ? <Loader2 className="animate-spin" aria-hidden /> : null}
          {t("customTabs.updateNotice.keepCurrent", "Keep current version")}
        </Button>
        {update.blocked_reason ? null : (
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={disabled || discard.pending}
            onClick={onReview}
          >
            {t("customTabs.customTabUpdateNotice.reviewPermissions", "Review permissions")}
          </Button>
        )}
      </span>
    </div>
  );
}

function ReadyText({
  version,
  installed,
}: {
  version: string;
  installed: string | null | undefined;
}): React.JSX.Element {
  const { t } = useUiTranslation();
  return (
    <span>
      <span className="font-medium text-foreground">
        <UiTrans
          i18nKey="customTabs.updateNotice.ready"
          defaults="Update <version/> ready — review permissions."
          components={{ version: <span className="font-mono">{version}</span> }}
        />
      </span>{" "}
      {installed ? (
        <UiTrans
          i18nKey="customTabs.updateNotice.installedVersion"
          defaults="<version/> keeps running until you allow it."
          components={{ version: <span className="font-mono">{installed}</span> }}
        />
      ) : (
        t(
          "customTabs.updateNotice.installedVersionFallback",
          "The installed version keeps running until you allow it.",
        )
      )}
    </span>
  );
}

/** Discards the staged update, then refetches until the lists no longer show it. */
function useDiscard(tab: PluginTabSummary): { pending: boolean; run: () => Promise<void> } {
  const mutation = useDiscardManagedTabUpdate();
  const [refreshing, setRefreshing] = useState(false);
  const run = async (): Promise<void> => {
    try {
      await mutation.mutateAsync({ id: tab.id });
    } catch (error: unknown) {
      if (apiErrorCode(error) === PLUGIN_TAB_ERROR.updateNotFound) {
        toast.info(
          translateUi(
            "customTabs.updateNotice.notWaiting",
            "No update to “{{name}}” was waiting anymore.",
            { name: tab.name },
          ),
        );
      } else {
        toastError(
          error,
          translateUi(
            "customTabs.updateNotice.discardError",
            "Could not discard the update to “{{name}}”",
            { name: tab.name },
          ),
        );
        return;
      }
    }
    setRefreshing(true);
    try {
      await refreshPluginTabsOrToast();
    } finally {
      setRefreshing(false);
    }
  };
  return { pending: mutation.isPending || refreshing, run };
}
