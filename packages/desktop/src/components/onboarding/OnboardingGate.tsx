import { translateUi, useUiTranslation } from "@/lib/i18n/ui";
import { useCallback, useEffect, useState, type ComponentProps, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { apiErrorCode, apiErrorMessage, isSettingsRepairError, toastError } from "@/lib/api-errors";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import {
  readTelemetry,
  needsTelemetryDecision,
  TELEMETRY_QUERY_KEY,
  type TelemetryState,
} from "@/api/telemetry";
import { useOnboardingStatus } from "@/hooks/useOnboardingStatus";
import { useTelemetryActivity } from "@/hooks/useTelemetryActivity";
import { isBrowserRemote } from "@/lib/remote/device-token";
import { COMPLETED_ONBOARDING_STEP, FIRST_ONBOARDING_STEP } from "@/lib/onboarding-step";
import { TelemetryDecisionDialog } from "@/components/telemetry/TelemetryDecisionDialog";
import { LazyBoundary } from "@/components/lazy/LazyBoundary";
import { lazyChunk } from "@/components/lazy/lazy-chunk";
import { SettingsUnreadableDialog } from "./SettingsUnreadableDialog";

interface OnboardingGateProps {
  children: ReactNode;
  openSettings: () => Promise<void>;
  languageSuggestion?: ReactNode;
}

const SETTINGS_RECHECK_MS = 2_000;
const FIRST_USE_RECHECK_MS = 5_000;

// Shown once per workspace: its chunk (and the settings rows it reuses) loads only then.
const OnboardingOverlay = lazyChunk(() =>
  import("./OnboardingOverlay").then((module) => module.OnboardingOverlay),
);

function LazyOnboardingOverlay(props: ComponentProps<typeof OnboardingOverlay>): ReactNode {
  const { t } = useUiTranslation();
  return (
    <LazyBoundary label={t("lazy.labels.onboarding", "onboarding")}>
      <OnboardingOverlay {...props} />
    </LazyBoundary>
  );
}

/** Remote browsers never read or change the host's local privacy decision. */
export function OnboardingGate(props: OnboardingGateProps): React.JSX.Element {
  return isBrowserRemote() ? <>{props.children}</> : <LocalOnboardingGate {...props} />;
}

function LocalOnboardingGate({
  children,
  openSettings,
  languageSuggestion,
}: OnboardingGateProps): React.JSX.Element {
  const onboarding = useOnboardingStatus();
  const telemetry = useQuery({
    queryKey: TELEMETRY_QUERY_KEY,
    queryFn: readTelemetry,
    retry: false,
  });
  const state = telemetry.data;
  const hasDecision = Boolean(state && !needsTelemetryDecision(state));
  const workspaceReady = onboarding.isCompleted && hasDecision;
  const [workspaceWasReady, setWorkspaceWasReady] = useState(false);
  if (workspaceReady && !workspaceWasReady) setWorkspaceWasReady(true);
  const preferencesError = telemetry.error ?? onboarding.error;
  const repairError = [onboarding.error, telemetry.error].find((error) =>
    isSettingsRepairError(apiErrorCode(error)),
  );
  const [repair, setRepair] = useState<{ error: unknown; opened: boolean } | null>(null);
  const isFetching = onboarding.isFetching || telemetry.isFetching;
  if (repairError !== undefined && repair === null)
    setRepair({ error: repairError, opened: false });
  if (repairError === undefined && !isFetching && repair !== null) setRepair(null);

  const visibleRepairError = repairError ?? repair?.error;
  const needsRepair = visibleRepairError !== undefined;
  const repairOpened = repair?.opened === true;
  const activityError = useTelemetryActivity(
    Boolean(
      !needsRepair &&
      !preferencesError &&
      (!workspaceWasReady || hasDecision) &&
      state?.audience_enabled &&
      state.audience_configured,
    ),
  );
  const { retry, verifyingDecision } = useSettingsRecheck({
    onboarding,
    telemetry,
    needsRepair,
    workspaceWasReady,
  });

  let content: ReactNode = null;
  if (needsRepair && !repairOpened) {
    content = (
      <SettingsUnreadableDialog
        error={visibleRepairError}
        modal={!workspaceReady}
        retry={retry}
        busy={isFetching}
        openSettings={() => {
          setRepair({ error: visibleRepairError, opened: true });
          void openSettings().catch((error: unknown) => {
            setRepair((current) => current && { ...current, opened: false });
            toastError(
              error,
              translateUi("onboarding.unreadable.openSettingsFailed", "Could not open Settings."),
            );
          });
        }}
      />
    );
  } else if (!needsRepair && !workspaceReady) {
    if (telemetry.isPending || onboarding.isLoading || preferencesError) {
      content = (
        <TelemetryDecisionDialog error={preferencesError} retry={retry} busy={isFetching} />
      );
    } else if (!onboarding.isCompleted && state) {
      content = (
        <LazyOnboardingOverlay telemetryState={state} showWelcomeIntro={!workspaceWasReady} />
      );
    } else if (state && needsTelemetryDecision(state)) {
      content = verifyingDecision ? (
        <SettingsRecheckStatus />
      ) : (
        <TelemetryDecisionDialog state={state} retry={retry} busy={false} />
      );
    }
  }
  return (
    <>
      {workspaceReady || repairOpened ? children : null}
      {content}
      {workspaceReady && !needsRepair && !preferencesError && languageSuggestion}
      {workspaceReady && !needsRepair && preferencesError ? (
        <PrivacyRefreshNotice error={preferencesError} busy={telemetry.isFetching} retry={retry} />
      ) : null}
      {activityError && !preferencesError ? <AudienceErrorNotice error={activityError} /> : null}
    </>
  );
}

function AudienceErrorNotice({ error }: { error: string }): React.JSX.Element {
  const { t } = useUiTranslation();
  return (
    <p
      role="status"
      className="fixed bottom-4 left-4 z-50 max-w-md rounded-md border border-border bg-background p-3 text-xs text-muted-foreground"
    >
      {t("telemetry.gate.audienceError", "Monthly audience counter: {{error}}", { error })}
    </p>
  );
}

function PrivacyRefreshNotice({
  error,
  busy,
  retry,
}: {
  error: unknown;
  busy: boolean;
  retry: () => void;
}) {
  const { t } = useUiTranslation();
  return (
    <div
      role="status"
      className="fixed bottom-4 left-4 z-50 max-w-md rounded-md border border-border bg-background p-3 text-xs text-muted-foreground"
    >
      <p>
        {apiErrorMessage(
          error,
          t("telemetry.gate.refreshError", "Could not refresh privacy preferences."),
        )}{" "}
        {t("telemetry.gate.savedChoices", "Your saved privacy choices remain in effect.")}
      </p>
      <Button variant="outline" size="sm" disabled={busy} onClick={retry}>
        {t("common.retry", "Retry")}
      </Button>
    </div>
  );
}

function useSettingsRecheck({
  onboarding,
  telemetry,
  needsRepair,
  workspaceWasReady,
}: {
  onboarding: ReturnType<typeof useOnboardingStatus>;
  telemetry: UseQueryResult<TelemetryState>;
  needsRepair: boolean;
  workspaceWasReady: boolean;
}) {
  const isFetching = onboarding.isFetching || telemetry.isFetching;
  const missingSavedDecision =
    workspaceWasReady &&
    onboarding.isCompleted &&
    telemetry.data !== undefined &&
    needsTelemetryDecision(telemetry.data);
  const [confirmedMissing, setConfirmedMissing] = useState(false);
  if (!missingSavedDecision && confirmedMissing) setConfirmedMissing(false);
  const verifyingDecision = missingSavedDecision && !confirmedMissing;
  const { refetch } = telemetry;
  const { retry: retryOnboarding } = onboarding;
  const retry = useCallback(() => {
    // One read can see the missing file while the other sees its replacement.
    // Confirm the absent decision using new reads after both have settled.
    const confirming = verifyingDecision && !isFetching;
    void Promise.all([refetch({ cancelRefetch: false }), retryOnboarding()]).then(
      ([result, step]) => {
        if (
          confirming &&
          step === COMPLETED_ONBOARDING_STEP &&
          result.isSuccess &&
          needsTelemetryDecision(result.data)
        ) {
          setConfirmedMissing(true);
        }
      },
    );
  }, [isFetching, refetch, retryOnboarding, verifyingDecision]);

  // Welcome and the privacy gate can unmount the workspace and its app socket.
  const awaitingSettings =
    needsRepair ||
    verifyingDecision ||
    (!telemetry.isPending && onboarding.step === FIRST_ONBOARDING_STEP);
  const enabled = awaitingSettings && !isFetching && !onboarding.isPersisting;
  const delay = needsRepair || workspaceWasReady ? SETTINGS_RECHECK_MS : FIRST_USE_RECHECK_MS;
  useEffect(() => {
    if (!enabled) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "hidden") retry();
    }, delay);
    return () => window.clearInterval(timer);
  }, [delay, enabled, retry]);
  return { retry, verifyingDecision };
}

function SettingsRecheckStatus(): React.JSX.Element {
  const { t } = useUiTranslation();
  return (
    <div
      role="status"
      className="fixed inset-0 flex items-center justify-center gap-2 text-muted-foreground"
    >
      <Loader2 className="size-4 animate-spin" aria-hidden />
      {t("onboarding.unreadable.checking", "Checking settings…")}
    </div>
  );
}
