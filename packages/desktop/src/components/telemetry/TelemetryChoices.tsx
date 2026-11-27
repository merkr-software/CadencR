import { useUiTranslation } from "@/lib/i18n/ui";
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Bug, ChartNoAxesCombined, Loader2, ShieldCheck } from "lucide-react";
import {
  updateTelemetry,
  TELEMETRY_QUERY_KEY,
  type TelemetryPreferences,
  type TelemetryState,
} from "@/api/telemetry";
import { apiErrorMessage } from "@/lib/api-errors";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";

export function TelemetryChoices({
  state,
  onSaved,
  disabled = false,
}: {
  state: TelemetryState;
  onSaved?: () => void;
  disabled?: boolean;
}): React.JSX.Element {
  const { t } = useUiTranslation();
  const client = useQueryClient();
  const [customizing, setCustomizing] = useState(false);
  const [choices, setChoices] = useState<
    Pick<TelemetryPreferences, "diagnostics_enabled" | "usage_enabled">
  >({
    diagnostics_enabled: false,
    usage_enabled: false,
  });
  const save = useMutation({
    mutationFn: updateTelemetry,
    onSuccess: (confirmed) => {
      client.setQueryData(TELEMETRY_QUERY_KEY, confirmed);
      onSaved?.();
    },
  });
  const busy = disabled || save.isPending;
  const chooseDetailed = (enabled: boolean): void =>
    save.mutate({ diagnostics_enabled: enabled, usage_enabled: enabled });
  return (
    <div className="space-y-5">
      <TelemetryExplanation state={state} />
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <Button className="sm:col-span-2" disabled={busy} onClick={() => chooseDetailed(true)}>
          {t("telemetry.consent.enable", "Enable diagnostics & usage")}
        </Button>
        <Button variant="outline" disabled={busy} onClick={() => chooseDetailed(false)}>
          {t("telemetry.consent.decline", "Decline detailed telemetry")}
        </Button>
        <Button
          variant="ghost"
          disabled={busy}
          aria-expanded={customizing}
          aria-controls="detailed-telemetry-options"
          onClick={() => setCustomizing(true)}
        >
          {t("telemetry.consent.customize", "Customize")}
        </Button>
      </div>
      {customizing ? (
        <div
          id="detailed-telemetry-options"
          className="space-y-4 rounded-lg border border-border bg-muted/20 p-4"
        >
          <Choice
            id="consent-diagnostics"
            label={t("telemetry.consent.technicalDiagnostics", "Technical diagnostics")}
            description={t(
              "telemetry.consent.diagnosticsExplanation",
              "Sentry receives curated error categories and app stack locations to help fix crashes.",
            )}
            checked={choices.diagnostics_enabled}
            disabled={busy}
            onChange={(value) =>
              setChoices((current) => ({ ...current, diagnostics_enabled: value }))
            }
          />
          <Choice
            id="consent-usage"
            label={t("telemetry.consent.usageAnalytics", "Usage analytics")}
            description={t(
              "telemetry.consent.usageExplanation",
              "PostHog receives basic app sessions and feature outcomes to show which features help.",
            )}
            checked={choices.usage_enabled}
            disabled={busy}
            onChange={(value) => setChoices((current) => ({ ...current, usage_enabled: value }))}
          />
          <Button variant="outline" disabled={busy} onClick={() => save.mutate(choices)}>
            {t("telemetry.consent.save", "Save my choices")}
          </Button>
        </div>
      ) : null}
      {save.isPending ? (
        <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" aria-hidden />
          {t("telemetry.consent.saving", "Saving your choices…")}
        </p>
      ) : null}
      {save.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {apiErrorMessage(
            save.error,
            t("telemetry.consent.saveError", "Could not save your privacy choices."),
          )}{" "}
          {t("telemetry.consent.saveRetry", "Your choice has not been saved. Please try again.")}
        </p>
      ) : null}
    </div>
  );
}

function Choice({
  id,
  label,
  description,
  checked,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  description: string;
  checked: boolean;
  disabled: boolean;
  onChange: (value: boolean) => void;
}): React.JSX.Element {
  return (
    <div className="flex items-start justify-between gap-4">
      <label htmlFor={id} className="space-y-1">
        <span className="block text-sm font-medium">{label}</span>
        <span className="block text-xs leading-relaxed text-muted-foreground">{description}</span>
      </label>
      <Switch
        id={id}
        aria-label={label}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onChange}
      />
    </div>
  );
}

function TelemetryExplanation({ state }: { state: TelemetryState }): React.JSX.Element {
  const { t } = useUiTranslation();
  return (
    <div className="space-y-4 text-xs leading-relaxed text-muted-foreground">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-2 rounded-lg border border-border bg-muted/20 p-3">
          <h3 className="flex items-center gap-2 text-sm font-medium text-foreground">
            <Bug className="size-4 text-muted-foreground" aria-hidden />
            {t("telemetry.consent.diagnosticsTitle", "Fix bugs faster")}
          </h3>
          <p>
            {t("telemetry.consent.diagnosticsSummary", "Send technical error reports to Sentry.")}
          </p>
          {!state.diagnostics_configured ? (
            <p>{t("telemetry.consent.unconfigured", "Not configured in this build.")}</p>
          ) : null}
        </div>
        <div className="space-y-2 rounded-lg border border-border bg-muted/20 p-3">
          <h3 className="flex items-center gap-2 text-sm font-medium text-foreground">
            <ChartNoAxesCombined className="size-4 text-muted-foreground" aria-hidden />
            {t("telemetry.consent.usageTitle", "Improve useful features")}
          </h3>
          <p>{t("telemetry.consent.usageSummary", "Share basic usage statistics with PostHog.")}</p>
          {!state.usage_configured ? (
            <p>{t("telemetry.consent.unconfigured", "Not configured in this build.")}</p>
          ) : null}
        </div>
      </div>
      <div className="flex items-start gap-2">
        <ShieldCheck className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
        <p>
          {t(
            "telemetry.consent.excludedData",
            "Your code, prompts, agent replies and terminal output are never included.",
          )}
        </p>
      </div>
      <p>
        {t(
          "telemetry.consent.defaults",
          "Both are off until enabled. Change your choices any time in Settings.",
        )}
      </p>
      <details>
        <summary className="cursor-pointer font-medium text-foreground">
          {t("telemetry.consent.detailsTitle", "What is shared?")}
        </summary>
        <div className="mt-2 space-y-2">
          <p>
            {t(
              "telemetry.consent.detailsContent",
              "Technical diagnostics send curated error categories and app stack positions to Sentry. Raw error messages and stack source text stay local. Usage analytics send basic app sessions and feature outcomes to PostHog.",
            )}
          </p>
          <p>
            {t(
              "telemetry.consent.detailsIdentifiers",
              "Both include app version, platform and a random installation ID, which links reports from this installation. Workspace file paths, repository names, log files and session replay are never sent.",
            )}
          </p>
          <p>
            {t(
              "telemetry.consent.detailsIp",
              "PostHog receives the connection IP when an event is delivered, even though the payload suppresses IP storage and geolocation.",
            )}
          </p>
        </div>
      </details>
      <section
        aria-label={t("telemetry.audience.title", "Monthly audience counter")}
        className="space-y-2 border-t border-border pt-4"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-medium text-foreground">
            {t("telemetry.audience.title", "Monthly audience counter")}
          </h3>
          <span>
            {!state.audience_enabled
              ? t("telemetry.audience.off", "Off — your setting is kept")
              : !state.audience_configured
                ? t("telemetry.audience.unconfigured", "Not configured — nothing sent")
                : t("telemetry.audience.defaultOn", "On by default")}
          </span>
        </div>
        <p>
          {t(
            "telemetry.audience.description",
            "One minimal monthly PostHog event estimates active installations. Fresh ID; no linking across months or to detailed reports. When on and configured, it runs independently, even before this choice. These buttons do not change it. Turn off in Settings → About → Privacy and telemetry.",
          )}
        </p>
      </section>
    </div>
  );
}
