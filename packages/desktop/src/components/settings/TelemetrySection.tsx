import { useUiTranslation, type UiTranslator } from "@/lib/i18n/ui";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import {
  readTelemetry,
  resetTelemetryIdentity,
  updateTelemetry,
  type TelemetryPreferences,
  type TelemetryState,
  TELEMETRY_QUERY_KEY,
  needsTelemetryDecision,
} from "@/api/telemetry";
import { apiErrorMessage } from "@/lib/api-errors";
import { desktopBridge } from "@/lib/desktop-bridge";
import { isBrowserRemote } from "@/lib/remote/device-token";
import { Button } from "@/components/ui/button";
import { TelemetryDetails } from "./TelemetryDetails";
import { SettingsGroup } from "./SettingsGroup";
import { SettingsSwitchRow } from "./SettingsSwitchRow";
import { SettingsSubsection } from "./SettingsSubsection";
import { SETTINGS_ANCHORS } from "./settings-anchor-ids";

const queryKey = TELEMETRY_QUERY_KEY;
function deliveryStatus(t: UiTranslator, status: TelemetryState["diagnostics_status"]): string {
  switch (status) {
    case "disabled":
      return t("system.telemetry.disabled", "Off — nothing is sent.");
    case "not_configured":
      return t("system.telemetry.notConfigured", "Not configured in this build — nothing is sent.");
    case "ready":
      return t("system.telemetry.ready", "Enabled — ready to send.");
    case "delivery_failed":
      return t(
        "system.telemetry.deliveryFailed",
        "Delivery failed. Reports may be dropped while offline.",
      );
  }
}

type Notice = "saved" | "reset";

export function TelemetrySection(): React.JSX.Element {
  const { t } = useUiTranslation();
  if (isBrowserRemote()) {
    return (
      <SettingsGroup
        id={SETTINGS_ANCHORS.telemetry}
        title={t("system.telemetrySection.privacyAndTelemetry", "Privacy and telemetry")}
      >
        <SettingsSubsection>
          <p className="text-xs text-muted-foreground">
            {t(
              "system.telemetrySection.manageTelemetryFromTheLocalCadencrDesktop",
              "Manage telemetry from the local Cadencr desktop. Its choices apply to the host, including operations started from remote devices. Remote browser errors stay local.",
            )}
          </p>
        </SettingsSubsection>
      </SettingsGroup>
    );
  }
  return <LocalTelemetrySection />;
}

function LocalTelemetrySection(): React.JSX.Element {
  const { t } = useUiTranslation();
  const client = useQueryClient();
  const [notice, setNotice] = useState<Notice | null>(null);
  const query = useQuery({ queryKey, queryFn: readTelemetry, refetchInterval: 5000, retry: false });
  const relay = useQuery({
    queryKey: ["telemetry-relay-status"],
    queryFn: () => desktopBridge.telemetryRelayStatus?.() ?? Promise.resolve("idle" as const),
    refetchInterval: 5000,
    retry: false,
  });
  const save = useMutation({
    mutationFn: updateTelemetry,
    onSuccess: (state) => {
      client.setQueryData(queryKey, state);
      setNotice("saved");
    },
  });
  const reset = useMutation({
    mutationFn: resetTelemetryIdentity,
    onSuccess: (state) => {
      client.setQueryData(queryKey, state);
      setNotice("reset");
    },
  });
  const state = query.data;
  const pending = save.isPending || reset.isPending;
  const update = (field: keyof TelemetryPreferences, value: boolean): void => {
    if (!state) return;
    setNotice(null);
    reset.reset();
    save.mutate({
      diagnostics_enabled: state.diagnostics_enabled,
      usage_enabled: state.usage_enabled,
      audience_enabled: state.audience_enabled,
      [field]: value,
    });
  };
  return (
    <SettingsGroup
      id={SETTINGS_ANCHORS.telemetry}
      title={t("system.telemetrySection.privacyAndTelemetry", "Privacy and telemetry")}
      description={t(
        "system.telemetrySection.diagnosticsAndUsageStartOffTheMonthly",
        "Diagnostics and usage start off. The monthly audience counter starts on when configured and sends independently, including before your detailed telemetry choice. These choices apply to this host, including operations started from remote devices.",
      )}
    >
      {query.isPending ? <TelemetryLoading /> : null}
      {query.isError ? (
        <TelemetryReadFailure
          error={query.error}
          busy={query.isFetching}
          retry={() => void query.refetch()}
        />
      ) : null}
      {state ? (
        <>
          <TelemetryDecisionStatus state={state} />
          <TelemetryControls state={state} disabled={pending || query.isError} update={update} />
          <TelemetryDetails
            disabled={pending || query.isError}
            onReset={() => {
              setNotice(null);
              save.reset();
              reset.mutate();
            }}
          />
        </>
      ) : null}
      <TelemetryNotice
        pending={pending}
        notice={notice}
        saveError={save.isError ? { detail: save.error } : null}
        resetError={reset.isError ? { detail: reset.error } : null}
        relayStatus={relay.isError ? "unavailable" : relay.data}
      />
    </SettingsGroup>
  );
}

function TelemetryNotice({
  pending,
  notice,
  saveError,
  resetError,
  relayStatus,
}: {
  pending: boolean;
  notice: Notice | null;
  saveError: { detail: unknown } | null;
  resetError: { detail: unknown } | null;
  relayStatus: "idle" | "unavailable" | "frames_unavailable" | undefined;
}): React.JSX.Element | null {
  const { t } = useUiTranslation();
  let message: string;
  if (pending) {
    message = t("system.telemetry.saving", "Saving…");
  } else if (saveError != null) {
    message = apiErrorMessage(
      saveError.detail,
      t("system.telemetry.saveError", "Could not save preferences."),
    );
  } else if (resetError != null) {
    message = apiErrorMessage(
      resetError.detail,
      t("system.telemetry.resetError", "Could not reset identity."),
    );
  } else if (relayStatus === "unavailable") {
    message = t(
      "system.telemetry.relayUnavailable",
      "Desktop diagnostic delivery is unavailable. Local diagnostic reports are still kept on this computer.",
    );
  } else if (relayStatus === "frames_unavailable") {
    message = t(
      "system.telemetry.relayFramesUnavailable",
      "Bundled stack locations are unavailable. Diagnostics contain error categories only.",
    );
  } else if (notice === "saved") {
    message = t("system.telemetry.saved", "Preferences saved.");
  } else if (notice === "reset") {
    message = t("system.telemetry.reset", "Telemetry ID reset. Previous events are not deleted.");
  } else {
    return null;
  }

  return (
    <SettingsSubsection>
      <p
        role={saveError != null || resetError != null ? "alert" : "status"}
        aria-live="polite"
        className="text-xs text-muted-foreground"
      >
        {message}
      </p>
    </SettingsSubsection>
  );
}

function TelemetryControls({
  state,
  disabled,
  update,
}: {
  state: TelemetryState;
  disabled: boolean;
  update: (field: keyof TelemetryPreferences, value: boolean) => void;
}): React.JSX.Element {
  const { t } = useUiTranslation();
  const audienceLabel = t(
    "system.telemetrySection.monthlyAudienceCounter",
    "Monthly audience counter",
  );
  const diagnosticsLabel = t(
    "system.telemetrySection.technicalDiagnostics",
    "Technical diagnostics",
  );
  const usageLabel = t("system.telemetrySection.usageAnalytics", "Usage analytics");
  return (
    <>
      <SettingsSwitchRow
        id="telemetry-audience"
        label={audienceLabel}
        ariaLabel={audienceLabel}
        align="center"
        description={t(
          "system.telemetry.audienceDescription",
          "Estimate active installations with one minimal monthly PostHog event using a fresh ID, without a persistent identifier or linking across months or to detailed analytics. The count is approximate and does not track sessions or features. {{status}}",
          { status: deliveryStatus(t, state.audience_status) },
        )}
        checked={state.audience_enabled}
        disabled={disabled}
        onCheckedChange={(value) => update("audience_enabled", value)}
      />
      <SettingsSwitchRow
        divided
        id="telemetry-diagnostics"
        label={diagnosticsLabel}
        ariaLabel={diagnosticsLabel}
        align="center"
        description={
          <>
            {t(
              "system.telemetry.diagnosticsDescription",
              "Send curated error categories and app stack locations to Sentry to help fix crashes. {{status}}",
              {
                status: deliveryStatus(t, state.diagnostics_status),
              },
            )}
            {!state.diagnostics_configured && state.diagnostics_status !== "not_configured" ? (
              <>
                {" "}
                {t("system.telemetry.noSentry", "This build has no Sentry destination configured.")}
              </>
            ) : null}
          </>
        }
        checked={state.diagnostics_enabled}
        disabled={disabled}
        onCheckedChange={(value) => update("diagnostics_enabled", value)}
      />
      <SettingsSwitchRow
        divided
        id="telemetry-usage"
        label={usageLabel}
        ariaLabel={usageLabel}
        align="center"
        description={
          <>
            {t(
              "system.telemetry.usageDescription",
              "Send basic app sessions and feature outcomes to PostHog to understand which features help. {{status}}",
              {
                status: deliveryStatus(t, state.usage_status),
              },
            )}
            {!state.usage_configured && state.usage_status !== "not_configured" ? (
              <>
                {" "}
                {t(
                  "system.telemetry.noPostHog",
                  "This build has no PostHog destination configured.",
                )}
              </>
            ) : null}
          </>
        }
        checked={state.usage_enabled}
        disabled={disabled}
        onCheckedChange={(value) => update("usage_enabled", value)}
      />
    </>
  );
}

function TelemetryLoading(): React.JSX.Element {
  const { t } = useUiTranslation();
  return (
    <SettingsSubsection>
      <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="size-4 animate-spin" aria-hidden />
        {t("system.telemetrySection.loadingPrivacyPreferences", "Loading privacy preferences…")}
      </p>
    </SettingsSubsection>
  );
}

function TelemetryReadFailure({
  error,
  busy,
  retry,
}: {
  error: unknown;
  busy: boolean;
  retry: () => void;
}): React.JSX.Element {
  const { t } = useUiTranslation();
  return (
    <SettingsSubsection>
      <p role="alert" className="text-xs text-destructive">
        {apiErrorMessage(
          error,
          t("system.telemetry.loadError", "Could not load telemetry preferences."),
        )}{" "}
        {t(
          "system.telemetry.disconnected",
          "Preferences are unavailable while the service is disconnected.",
        )}
      </p>
      <Button variant="outline" size="sm" onClick={retry} disabled={busy}>
        {t("system.telemetrySection.retry", "Retry")}
      </Button>
    </SettingsSubsection>
  );
}

function TelemetryDecisionStatus({ state }: { state: TelemetryState }): React.JSX.Element {
  const { t } = useUiTranslation();
  return (
    <SettingsSubsection>
      <p className="text-xs text-muted-foreground">
        {needsTelemetryDecision(state)
          ? t("system.telemetry.decisionPending", "Detailed telemetry decision not yet saved.")
          : t("system.telemetry.decisionSaved", "Detailed telemetry decision saved.")}
      </p>
    </SettingsSubsection>
  );
}
