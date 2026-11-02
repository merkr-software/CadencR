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
          Enable diagnostics &amp; usage
        </Button>
        <Button variant="outline" disabled={busy} onClick={() => chooseDetailed(false)}>
          Decline detailed telemetry
        </Button>
        <Button
          variant="ghost"
          disabled={busy}
          aria-expanded={customizing}
          aria-controls="detailed-telemetry-options"
          onClick={() => setCustomizing(true)}
        >
          Customize
        </Button>
      </div>
      {customizing ? (
        <div
          id="detailed-telemetry-options"
          className="space-y-4 rounded-lg border border-border bg-muted/20 p-4"
        >
          <Choice
            id="consent-diagnostics"
            label="Technical diagnostics"
            description="Sentry receives curated error categories and app stack locations to help fix crashes."
            checked={choices.diagnostics_enabled}
            disabled={busy}
            onChange={(value) =>
              setChoices((current) => ({ ...current, diagnostics_enabled: value }))
            }
          />
          <Choice
            id="consent-usage"
            label="Usage analytics"
            description="PostHog receives basic app sessions and feature outcomes to show which features help."
            checked={choices.usage_enabled}
            disabled={busy}
            onChange={(value) => setChoices((current) => ({ ...current, usage_enabled: value }))}
          />
          <Button variant="outline" disabled={busy} onClick={() => save.mutate(choices)}>
            Save my choices
          </Button>
        </div>
      ) : null}
      {save.isPending ? (
        <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" aria-hidden />
          Saving your choices…
        </p>
      ) : null}
      {save.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {apiErrorMessage(save.error, "Could not save your privacy choices.")} Your choice has not
          been saved. Please try again.
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
  return (
    <div className="space-y-4 text-xs leading-relaxed text-muted-foreground">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-2 rounded-lg border border-border bg-muted/20 p-3">
          <h3 className="flex items-center gap-2 text-sm font-medium text-foreground">
            <Bug className="size-4 text-muted-foreground" aria-hidden />
            Fix bugs faster
          </h3>
          <p>Send technical error reports to Sentry.</p>
          {!state.diagnostics_configured ? <p>Not configured in this build.</p> : null}
        </div>
        <div className="space-y-2 rounded-lg border border-border bg-muted/20 p-3">
          <h3 className="flex items-center gap-2 text-sm font-medium text-foreground">
            <ChartNoAxesCombined className="size-4 text-muted-foreground" aria-hidden />
            Improve useful features
          </h3>
          <p>Share basic usage statistics with PostHog.</p>
          {!state.usage_configured ? <p>Not configured in this build.</p> : null}
        </div>
      </div>
      <div className="flex items-start gap-2">
        <ShieldCheck className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
        <p>Your code, prompts, agent replies and terminal output are never included.</p>
      </div>
      <p>Both are off until enabled. Change your choices any time in Settings.</p>
      <details>
        <summary className="cursor-pointer font-medium text-foreground">What is shared?</summary>
        <div className="mt-2 space-y-2">
          <p>
            Technical diagnostics send curated error categories and app stack positions to Sentry.
            Raw error messages and stack source text stay local. Usage analytics send basic app
            sessions and feature outcomes to PostHog.
          </p>
          <p>
            Both include app version, platform and a random installation ID, which links reports
            from this installation. Workspace file paths, repository names, log files and session
            replay are never sent.
          </p>
          <p>
            PostHog receives the connection IP when an event is delivered, even though the payload
            suppresses IP storage and geolocation.
          </p>
        </div>
      </details>
      <section
        aria-label="Monthly audience counter"
        className="space-y-2 border-t border-border pt-4"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-medium text-foreground">Monthly audience counter</h3>
          <span>
            {!state.audience_enabled
              ? "Off — your setting is kept"
              : !state.audience_configured
                ? "Not configured — nothing sent"
                : "On by default"}
          </span>
        </div>
        <p>
          One minimal monthly PostHog event estimates active installations. Fresh ID; no linking
          across months or to detailed reports. When on and configured, it runs independently, even
          before this choice. These buttons do not change it. Turn off in Settings → About → Privacy
          and telemetry.
        </p>
      </section>
    </div>
  );
}
