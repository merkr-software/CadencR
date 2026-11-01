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
import { Switch } from "@/components/ui/switch";
import { TelemetryDetails } from "./TelemetryDetails";
import { SettingsGroup } from "./SettingsGroup";
import { SettingsRow } from "./SettingsRow";
import { SettingsSubsection } from "./SettingsSubsection";
import { SETTINGS_ANCHORS } from "./settings-anchor-ids";

const queryKey = TELEMETRY_QUERY_KEY;
const statusLabels: Record<TelemetryState["diagnostics_status"], string> = {
  disabled: "Off — nothing is sent.",
  not_configured: "Not configured in this build — nothing is sent.",
  ready: "Enabled — ready to send.",
  delivery_failed: "Delivery failed. Reports may be dropped while offline.",
};

export function TelemetrySection(): React.JSX.Element {
  if (isBrowserRemote()) {
    return (
      <SettingsGroup id={SETTINGS_ANCHORS.telemetry} title="Privacy and telemetry">
        <SettingsSubsection>
          <p className="text-xs text-muted-foreground">
            Manage telemetry from the local Cadencr desktop. Its choices apply to the host,
            including operations started from remote devices. Remote browser errors stay local.
          </p>
        </SettingsSubsection>
      </SettingsGroup>
    );
  }
  return <LocalTelemetrySection />;
}

function LocalTelemetrySection(): React.JSX.Element {
  const client = useQueryClient();
  const [notice, setNotice] = useState<string | null>(null);
  const query = useQuery({ queryKey, queryFn: readTelemetry, refetchInterval: 5000, retry: false });
  const relay = useQuery({
    queryKey: ["telemetry-relay-status"],
    queryFn: () => desktopBridge.telemetryRelayStatus?.() ?? Promise.resolve("idle"),
    refetchInterval: 5000,
    retry: false,
  });
  const save = useMutation({
    mutationFn: updateTelemetry,
    onSuccess: (state) => {
      client.setQueryData(queryKey, state);
      setNotice("Preferences saved.");
    },
  });
  const reset = useMutation({
    mutationFn: resetTelemetryIdentity,
    onSuccess: (state) => {
      client.setQueryData(queryKey, state);
      setNotice("Telemetry ID reset. Previous events are not deleted.");
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
      title="Privacy and telemetry"
      description="Diagnostics and usage start off. The monthly audience counter starts on when configured and sends independently, including before your detailed telemetry choice. These choices apply to this host, including operations started from remote devices."
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
      {pending ||
      notice ||
      save.isError ||
      reset.isError ||
      relay.data === "unavailable" ||
      relay.data === "frames_unavailable" ||
      relay.isError ? (
        <SettingsSubsection>
          <p
            role={save.isError || reset.isError ? "alert" : "status"}
            aria-live="polite"
            className="text-xs text-muted-foreground"
          >
            {pending
              ? "Saving…"
              : save.isError
                ? apiErrorMessage(save.error, "Could not save preferences.")
                : reset.isError
                  ? apiErrorMessage(reset.error, "Could not reset identity.")
                  : relay.data === "unavailable" || relay.isError
                    ? "Desktop diagnostic delivery is unavailable. Local diagnostic reports are still kept on this computer."
                    : relay.data === "frames_unavailable"
                      ? "Bundled stack locations are unavailable. Diagnostics contain error categories only."
                      : notice}
          </p>
        </SettingsSubsection>
      ) : null}
    </SettingsGroup>
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
  return (
    <>
      <SettingsRow
        htmlFor="telemetry-audience"
        label="Monthly audience counter"
        description={`Estimate active installations with one minimal monthly PostHog event using a fresh ID, without a persistent identifier or linking across months or to detailed analytics. The count is approximate and does not track sessions or features. ${statusLabels[state.audience_status]}`}
        control={
          <Switch
            id="telemetry-audience"
            aria-label="Monthly audience counter"
            checked={state.audience_enabled}
            disabled={disabled}
            onCheckedChange={(value) => update("audience_enabled", value)}
          />
        }
      />
      <SettingsRow
        divided
        htmlFor="telemetry-diagnostics"
        label="Technical diagnostics"
        description={`Send curated error categories and app stack locations to Sentry to help fix crashes. ${statusLabels[state.diagnostics_status]}${!state.diagnostics_configured && state.diagnostics_status !== "not_configured" ? " This build has no Sentry destination configured." : ""}`}
        control={
          <Switch
            id="telemetry-diagnostics"
            aria-label="Technical diagnostics"
            checked={state.diagnostics_enabled}
            disabled={disabled}
            onCheckedChange={(value) => update("diagnostics_enabled", value)}
          />
        }
      />
      <SettingsRow
        divided
        htmlFor="telemetry-usage"
        label="Usage analytics"
        description={`Send basic app sessions and feature outcomes to PostHog to understand which features help. ${statusLabels[state.usage_status]}${!state.usage_configured && state.usage_status !== "not_configured" ? " This build has no PostHog destination configured." : ""}`}
        control={
          <Switch
            id="telemetry-usage"
            aria-label="Usage analytics"
            checked={state.usage_enabled}
            disabled={disabled}
            onCheckedChange={(value) => update("usage_enabled", value)}
          />
        }
      />
    </>
  );
}

function TelemetryLoading(): React.JSX.Element {
  return (
    <SettingsSubsection>
      <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="size-4 animate-spin" aria-hidden />
        Loading privacy preferences…
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
  return (
    <SettingsSubsection>
      <p role="alert" className="text-xs text-destructive">
        {apiErrorMessage(error, "Could not load telemetry preferences.")} Preferences are
        unavailable while the service is disconnected.
      </p>
      <Button variant="outline" size="sm" onClick={retry} disabled={busy}>
        Retry
      </Button>
    </SettingsSubsection>
  );
}

function TelemetryDecisionStatus({ state }: { state: TelemetryState }): React.JSX.Element {
  return (
    <SettingsSubsection>
      <p className="text-xs text-muted-foreground">
        {needsTelemetryDecision(state)
          ? "Detailed telemetry decision not yet saved."
          : "Detailed telemetry decision saved."}
      </p>
    </SettingsSubsection>
  );
}
