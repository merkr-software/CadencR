import { formattingLocale } from "@/lib/i18n/formatting-locale";
import { formatExactNumber } from "@/lib/format-number";
import { translateUi, useUiTranslation, type UiTranslator } from "@/lib/i18n/ui";
import { LoaderCircle, Play } from "lucide-react";
import {
  ArchivedCleanupRunStatus,
  useRunArchivedCleanup,
  type ArchivedCleanupRunResponse,
} from "@/api/generated";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useSetting } from "@/hooks/useSetting";
import { useSettingDraft, type SettingDraft } from "@/hooks/useSettingDraft";
import { toastError } from "@/lib/api-errors";
import { useStorageMaintenanceStore } from "@/stores/storage-maintenance-store";
import { SettingsGroup } from "./SettingsGroup";
import { SettingsRow } from "./SettingsRow";
import { SettingsPageSection } from "./SettingsPageSection";
import { SettingsSwitchRow } from "./SettingsSwitchRow";

/**
 * Keys must match `registry.rs` / `settings_allowlist/keys.rs` on the backend,
 * which owns the defaults mirrored here.
 */
const ENABLED_KEY = "retention_compact_archived_enabled";
const DAYS_KEY = "retention_compact_archived_days";

/** Off by default, matching the backend's `SettingSpec` for `ENABLED_KEY`. */
const DEFAULT_ENABLED = false;
const DEFAULT_DAYS = 30;
const MIN_DAYS = 1;
const MAX_DAYS = 365;
/** How long typing must pause before the retention window is saved. */
const DAYS_SAVE_DEBOUNCE_MS = 500;

/**
 * Settings → Storage. Controls the one maintenance pass that discards anything.
 *
 * The lossless passes — de-duplicating terminal output, moving images to disk —
 * always run and have nothing to configure, so they are described here but not
 * exposed as switches: there is no reason anyone would turn them off.
 */
export function StorageSection(): React.JSX.Element {
  const { t } = useUiTranslation();
  // Storage policy changes take effect only after the backend confirms them;
  // the days field marks its unsaved draft with a spinner until then.
  const enabledSetting = useSetting(ENABLED_KEY);
  const daysSetting = useSettingDraft(DAYS_KEY, DAYS_SAVE_DEBOUNCE_MS);

  const enabled = enabledSetting.value === null ? DEFAULT_ENABLED : enabledSetting.value === "true";
  const settingsBusy =
    enabledSetting.isLoading ||
    enabledSetting.isSaving ||
    daysSetting.isLoading ||
    daysSetting.isSaving;

  return (
    <SettingsPageSection pageId="storage">
      <SettingsGroup title={t("system.storageSection.archivedFeatures", "Archived features")}>
        <SettingsSwitchRow
          label={
            <span className="inline-flex items-center gap-1.5">
              {t("system.storage.compactArchived", "Compact archived features")}
              {enabledSetting.isSaving && (
                <LoaderCircle
                  aria-label={t(
                    "system.storageSection.savingStoragePolicy",
                    "Saving storage policy",
                  )}
                  className="size-3.5 animate-spin"
                />
              )}
            </span>
          }
          description={t(
            "system.storageSection.shortenLongBashOutputOnceAnArchived",
            "Shorten long Bash output once an archived thread has been quiet for the period below. The feature, its sessions and the conversation are kept: no rows are deleted, and what you and the agent wrote is never touched.",
          )}
          checked={enabled}
          onCheckedChange={(checked) => enabledSetting.setValue(checked ? "true" : "false")}
          disabled={enabledSetting.isLoading || enabledSetting.isSaving}
        />
        <SettingsRow
          divided
          align="start"
          label={t("system.storageSection.waitBeforeCompacting", "Wait before compacting")}
          description={t(
            "system.storageSection.howLongAnArchivedFeatureMustRemain",
            "How long an archived feature must remain archived and have no new thread activity before compaction. New activity or restoring it resets the clock.",
          )}
          control={
            <RetentionDaysControl
              setting={daysSetting}
              disabled={!enabled || daysSetting.isLoading}
            />
          }
        />
        <SettingsRow
          divided
          align="start"
          label={t("system.storageSection.runCleanupNow", "Run cleanup now")}
          description={t(
            "system.storageSection.checkEligibleArchivedConversationsImmediatelyInsteadOf",
            "Check eligible archived conversations immediately instead of waiting for the next automatic sweep. The saved retention window and all safety checks still apply.",
          )}
          control={<ManualCleanupControl enabled={enabled} settingsBusy={settingsBusy} />}
        />
      </SettingsGroup>
    </SettingsPageSection>
  );
}

function ManualCleanupControl({
  enabled,
  settingsBusy,
}: {
  enabled: boolean;
  settingsBusy: boolean;
}): React.JSX.Element {
  const { t, i18n } = useUiTranslation();
  const maintenanceRunning = useStorageMaintenanceStore((state) => {
    const phase = state.status?.phase;
    return phase === "started" || phase === "progress";
  });
  const runCleanup = useRunArchivedCleanup({
    mutation: {
      onError: (error) =>
        toastError(
          error,
          translateUi(
            "system.storage.cleanupError",
            "Could not start archived conversation cleanup",
          ),
        ),
    },
  });
  const runMessage = runCleanup.data
    ? runResultMessage(t, runCleanup.data, formattingLocale(i18n.language))
    : null;

  return (
    <div className="flex max-w-52 flex-col items-end gap-1.5">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={!enabled || settingsBusy || maintenanceRunning || runCleanup.isPending}
        onClick={() => runCleanup.mutate()}
      >
        {runCleanup.isPending ? (
          <LoaderCircle aria-hidden className="size-3.5 animate-spin" />
        ) : (
          <Play aria-hidden className="size-3.5" />
        )}
        {maintenanceRunning
          ? t("system.storage.cleanupRunning", "Cleanup running")
          : t("system.storage.runNow", "Run now")}
      </Button>
      {runMessage && (
        <p aria-live="polite" className="text-right text-[11px] text-muted-foreground">
          {runMessage}
        </p>
      )}
    </div>
  );
}

function runResultMessage(
  t: UiTranslator,
  response: ArchivedCleanupRunResponse,
  locale: string,
): string {
  switch (response.status) {
    case ArchivedCleanupRunStatus.started:
      return t(
        "system.storage.cleanupStarted",
        "Cleanup started for {{formattedCount}} archived conversations. Progress appears above Settings.",
        {
          count: response.eligible_features,
          formattedCount: formatExactNumber(response.eligible_features, locale),
          defaultValue_zero:
            "Cleanup started for {{formattedCount}} archived conversations. Progress appears above Settings.",
          defaultValue_one:
            "Cleanup started for {{formattedCount}} archived conversation. Progress appears above Settings.",
          defaultValue_other:
            "Cleanup started for {{formattedCount}} archived conversations. Progress appears above Settings.",
        },
      );
    case ArchivedCleanupRunStatus.already_running:
      return t("system.storage.alreadyRunning", "Storage maintenance is already running.");
    case ArchivedCleanupRunStatus.nothing_due:
      return t("system.storage.nothingDue", "No archived conversations currently need cleanup.");
  }
}

/**
 * The field shows what the user types as a draft, apart from the saved window:
 * it isn't the retention policy until the backend confirms it, and a failed
 * save drops it for the saved value. The spinner stays while either is pending.
 */
function RetentionDaysControl({
  setting,
  disabled,
}: {
  setting: SettingDraft;
  disabled: boolean;
}): React.JSX.Element {
  const { t, i18n } = useUiTranslation();
  const shown = setting.draft ?? setting.value;
  const days = clampDays(shown === null ? DEFAULT_DAYS : Number.parseInt(shown, 10));

  return (
    <div className="flex items-center gap-2">
      <Input
        type="number"
        lang={formattingLocale(i18n.language)}
        min={MIN_DAYS}
        max={MAX_DAYS}
        disabled={disabled}
        value={days}
        aria-label={t(
          "system.storageSection.daysBeforeAnArchivedFeatureIsCompacted",
          "Days before an archived feature is compacted",
        )}
        onChange={(event) =>
          setting.setDraft(String(clampDays(Number.parseInt(event.target.value, 10))))
        }
        className="h-7 w-16 text-center disabled:opacity-50"
      />
      <span className="text-xs text-muted-foreground">
        {t("system.storage.retentionDays", "days", {
          count: days,
          defaultValue_zero: "days",
          defaultValue_one: "day",
          defaultValue_other: "days",
        })}
      </span>
      {setting.isSaving && (
        <LoaderCircle
          aria-label={t("system.storageSection.savingRetentionWindow", "Saving retention window")}
          className="size-3.5 animate-spin"
        />
      )}
    </div>
  );
}

/** `NaN` (an emptied field) falls back to the default rather than to zero. */
function clampDays(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_DAYS;
  return Math.max(MIN_DAYS, Math.min(MAX_DAYS, Math.trunc(value)));
}
