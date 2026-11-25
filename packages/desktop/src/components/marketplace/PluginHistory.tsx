import type {
  ManagedFailureStage,
  ManagedHistoryAction,
  ManagedProviderInventoryEntry,
} from "@/api/generated";
import { formatAgo } from "@/lib/date-utils";
import { useUiTranslation, type UiTranslator } from "@/lib/i18n/ui";
import { cn } from "@/lib/utils";
import { formatDay } from "./PluginBits";
import { Section } from "./PluginDetailSections";

const ACTION_LABELS: Record<ManagedHistoryAction, (t: UiTranslator) => string> = {
  installed: (t) => t("marketplace.pluginDetailSections.history.installed", "Installed"),
  updated: (t) => t("marketplace.pluginDetailSections.history.updated", "Updated"),
  rolled_back: (t) => t("marketplace.pluginDetailSections.history.rolled_back", "Rolled back"),
  enabled: (t) => t("marketplace.pluginDetailSections.history.enabled", "Enabled"),
  disabled: (t) => t("marketplace.pluginDetailSections.history.disabled", "Disabled"),
  removed: (t) => t("marketplace.pluginDetailSections.history.removed", "Removed"),
};

const FAILURE_STAGES: Record<ManagedFailureStage, (t: UiTranslator) => string> = {
  trust: (t) => t("marketplace.pluginDetailSections.failureStage.trust", "trust"),
  compatibility: (t) =>
    t("marketplace.pluginDetailSections.failureStage.compatibility", "compatibility"),
  blocklist: (t) => t("marketplace.pluginDetailSections.failureStage.blocklist", "blocklist"),
  download: (t) => t("marketplace.pluginDetailSections.failureStage.download", "download"),
  extraction: (t) => t("marketplace.pluginDetailSections.failureStage.extraction", "extraction"),
  payload: (t) => t("marketplace.pluginDetailSections.failureStage.payload", "payload"),
  conformance: (t) => t("marketplace.pluginDetailSections.failureStage.conformance", "conformance"),
  activation: (t) => t("marketplace.pluginDetailSections.failureStage.activation", "activation"),
  rollback: (t) => t("marketplace.pluginDetailSections.failureStage.rollback", "rollback"),
  launch: (t) => t("marketplace.pluginDetailSections.failureStage.launch", "launch"),
};

/** Confirmed installation changes and quarantines, newest first. */
export function HistorySection({
  entry,
}: {
  entry: ManagedProviderInventoryEntry;
}): React.JSX.Element {
  const { t } = useUiTranslation();
  const events = [
    ...entry.history.map((event) => ({
      key: `h${event.sequence}`,
      at: event.occurred_at,
      label: Object.hasOwn(ACTION_LABELS, event.action)
        ? ACTION_LABELS[event.action](t)
        : event.action,
      detail:
        event.previous_version && event.previous_version !== event.version
          ? `${event.previous_version} → ${event.version ?? "—"}`
          : (event.version ?? ""),
      failed: false,
    })),
    ...entry.quarantine.map((event) => ({
      key: `q${event.sequence}`,
      at: event.occurred_at,
      label: t("marketplace.pluginDetailSections.quarantined", "Quarantined ({{stage}})", {
        stage: Object.hasOwn(FAILURE_STAGES, event.stage)
          ? FAILURE_STAGES[event.stage](t)
          : event.stage,
      }),
      detail: `${event.version} · ${event.code}: ${event.message}`,
      failed: true,
    })),
  ].sort((a, b) => b.at.localeCompare(a.at));
  return (
    <Section title={t("marketplace.pluginDetailSections.history.title", "History")}>
      {events.length ? (
        <ol className="relative space-y-3 border-l border-border/80 pl-4">
          {events.map((event) => (
            <li key={event.key} className="relative">
              <span
                className={cn(
                  "absolute -left-[21px] top-1.5 size-2 rounded-full ring-4 ring-background",
                  event.failed ? "bg-destructive" : "bg-muted-foreground/60",
                )}
              />
              <p className={cn("text-[12.5px] font-medium", event.failed && "text-destructive")}>
                {event.label}{" "}
                <span className="font-mono text-[11px] font-normal text-muted-foreground">
                  {event.detail}
                </span>
              </p>
              <p className="text-[11px] tabular-nums text-muted-foreground" title={event.at}>
                {formatDay(event.at)} · {formatAgo(event.at)}
              </p>
            </li>
          ))}
        </ol>
      ) : (
        <p className="text-xs text-muted-foreground">
          {t("marketplace.pluginDetailSections.noHistoryRecorded", "No history recorded.")}
        </p>
      )}
    </Section>
  );
}
