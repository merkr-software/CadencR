import { Button } from "@/components/ui/button";
import { apiErrorMessage } from "@/lib/api-errors";
import { useQuery } from "@tanstack/react-query";
import { readTelemetry, needsTelemetryDecision, TELEMETRY_QUERY_KEY } from "@/api/telemetry";
import { useOnboardingStatus } from "@/hooks/useOnboardingStatus";
import { useTelemetryActivity } from "@/hooks/useTelemetryActivity";
import { isBrowserRemote } from "@/lib/remote/device-token";
import { TelemetryDecisionDialog } from "@/components/telemetry/TelemetryDecisionDialog";
import { OnboardingOverlay } from "./OnboardingOverlay";

/** Remote browsers never read or change the host's local privacy decision. */
export function OnboardingGate({ children }: { children: React.ReactNode }): React.JSX.Element {
  return isBrowserRemote() ? (
    <>{children}</>
  ) : (
    <LocalOnboardingGate>{children}</LocalOnboardingGate>
  );
}

function LocalOnboardingGate({ children }: { children: React.ReactNode }): React.JSX.Element {
  const onboarding = useOnboardingStatus();
  const telemetry = useQuery({
    queryKey: TELEMETRY_QUERY_KEY,
    queryFn: readTelemetry,
    retry: false,
  });
  const state = telemetry.data;
  const hasDecision = Boolean(state && !needsTelemetryDecision(state));
  const workspaceReady = onboarding.isCompleted && hasDecision;
  const activityError = useTelemetryActivity(
    Boolean(state?.audience_enabled && state.audience_configured),
  );
  const preferencesError = telemetry.error ?? onboarding.error;
  const retry = (): void => {
    void telemetry.refetch();
    onboarding.retry();
  };
  let content: React.ReactNode;
  if (!workspaceReady && (telemetry.isPending || onboarding.isLoading || preferencesError)) {
    content = (
      <TelemetryDecisionDialog
        error={telemetry.error ?? onboarding.error}
        retry={retry}
        busy={telemetry.isFetching || onboarding.isLoading}
      />
    );
  } else if (!onboarding.isCompleted && state) {
    content = <OnboardingOverlay telemetryState={state} />;
  } else if (state && needsTelemetryDecision(state)) {
    content = <TelemetryDecisionDialog state={state} retry={retry} busy={false} />;
  } else {
    content = children;
  }
  return (
    <>
      {content}
      {workspaceReady && preferencesError ? (
        <div
          role="status"
          className="fixed bottom-4 left-4 z-50 max-w-md rounded-md border border-border bg-background p-3 text-xs text-muted-foreground"
        >
          <p>
            {apiErrorMessage(preferencesError, "Could not refresh privacy preferences.")} Your saved
            privacy choices remain in effect.
          </p>
          <Button variant="outline" size="sm" disabled={telemetry.isFetching} onClick={retry}>
            Retry
          </Button>
        </div>
      ) : null}
      {activityError && !preferencesError ? (
        <p
          role="status"
          className="fixed bottom-4 left-4 z-50 max-w-md rounded-md border border-border bg-background p-3 text-xs text-muted-foreground"
        >
          Monthly audience counter: {activityError}
        </p>
      ) : null}
    </>
  );
}
