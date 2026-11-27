import { type UiTranslator, useUiTranslation } from "@/lib/i18n/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useGetFeatureSettings } from "@/api/generated";
import { settingsArrayToMap } from "@/api/settings";
import type { WorktreeStatus } from "@/types/workflow";
import { useFeatureWorktreeInfo } from "@/hooks/useFeatureWorktreePath";
import type {
  WorktreeSetupDisplayStatus,
  WorktreeSetupHeaderProps,
} from "@/components/WorktreeSetupHeader";

type SetupStep = "naming" | "named" | "creating" | "created" | "setup" | "done" | "error";

const STEP_ORDER: SetupStep[] = ["naming", "named", "creating", "created", "setup", "done"];

function stepIndex(step: SetupStep): number {
  const idx = STEP_ORDER.indexOf(step);
  return idx >= 0 ? idx : -1;
}

/** Map WorktreeStatus from WS store to tRPC-style SetupStep */
function wsStatusToStep(status: WorktreeStatus): SetupStep | null {
  switch (status) {
    case "idle":
      return null;
    case "creating":
      return "creating";
    case "created":
      return "created";
    case "setup_running":
      return "setup";
    case "ready":
      return "done";
    case "setup_error":
      return "error";
  }
}

/** Map raw DB worktree_setup_step values to SetupStep (DB stores "ready", UI expects "done") */
function dbStepToSetupStep(raw: string | undefined): SetupStep | null {
  if (!raw) return null;
  if (raw === "ready") return "done";
  if (raw === "setup_running") return "setup";
  if (raw === "setup_error") return "error";
  return raw as SetupStep;
}

export interface WorktreeSetupInput {
  featureId: number;
  projectId: number;
  /** WS-driven worktree state (optional — when set, overrides tRPC polling) */
  wsWorktreeStatus?: WorktreeStatus;
  wsWorktreeBranch?: string | null;
  wsWorktreeSetupOutput?: string[];
  wsWorktreeError?: string | null;
  /** Retry handler invoked from the error state UI. ws-session callers always
   *  supply this; if omitted the retry button silently no-ops. */
  onRetrySetup?: () => void;
}

export interface SetupStepItem {
  id: "name" | "worktree" | "commands";
  label: string;
  complete: boolean;
  active: boolean;
  error: boolean;
  detail?: string;
  showLog?: boolean;
}

export interface WorktreeSetupDetailsProps {
  branch: string;
  branchExists: boolean | null;
  healthError: unknown;
  isMissing: boolean;
  steps: SetupStepItem[];
  log: string;
  isError: boolean;
  setupError: string;
  onRetrySetup?: () => void;
}

export interface WorktreeSetupState {
  header: WorktreeSetupHeaderProps;
  details: WorktreeSetupDetailsProps;
}

function useWorktreeSetupDisclosure(
  featureId: number,
  useWsMode: boolean,
  step: SetupStep | null,
): [boolean, () => void] {
  const [userToggle, setUserToggle] = useState<boolean | null>(null);
  const previousStepRef = useRef<SetupStep | null>(null);
  const didObserveStepRef = useRef(false);

  useEffect((): void => {
    setUserToggle(null);
    previousStepRef.current = null;
    didObserveStepRef.current = false;
  }, [featureId, useWsMode]);

  useEffect((): void => {
    if (!step) return;
    const previousStep = previousStepRef.current;
    previousStepRef.current = step;
    if (!didObserveStepRef.current) {
      didObserveStepRef.current = true;
      return;
    }
    if (previousStep !== step && step === "error") setUserToggle(true);
  }, [step]);

  // Stable, so the memoized header (and the memo'd Git host showing it) holds.
  const toggle = useCallback(() => setUserToggle((prev) => !(prev ?? false)), []);
  return [userToggle ?? false, toggle];
}

function buildSetupSteps(step: SetupStep, branch: string, t: UiTranslator): SetupStepItem[] {
  const currentStep = stepIndex(step);
  const worktreeCreated = !!branch;
  return [
    {
      id: "name",
      label: t("conversation.useWorktreeSetup.defineName", "Define name"),
      complete: worktreeCreated || currentStep >= 1,
      active: step === "naming",
      error: false,
    },
    {
      id: "worktree",
      label: t("conversation.useWorktreeSetup.createWorktree", "Create worktree"),
      complete: worktreeCreated || currentStep >= 3,
      active: step === "creating",
      error: false,
      detail: branch ? branch : undefined,
    },
    {
      id: "commands",
      label: t("conversation.useWorktreeSetup.runSetupCommands", "Run setup commands"),
      complete: step === "done",
      active: step === "setup",
      error: step === "error",
      showLog: true,
    },
  ];
}

function displayStatusOf(
  step: SetupStep | null,
  isMissing: boolean,
  healthFailed: boolean,
  healthLoading: boolean,
): WorktreeSetupDisplayStatus {
  if (isMissing) return "removed";
  if (healthFailed) return "health-error";
  if (step === "done") return healthLoading ? "checking" : "ready";
  return step && step !== "error" ? "running" : "setup-error";
}

/**
 * A feature's worktree setup state — WS-pushed when live, persisted settings
 * otherwise — plus the details disclosure; `null` when it has no worktree.
 * Kept apart from the rendering so the feature header can put the summary in
 * its title block and the details below it.
 */
export function useWorktreeSetup({
  featureId,
  projectId,
  wsWorktreeStatus,
  wsWorktreeBranch,
  wsWorktreeSetupOutput,
  wsWorktreeError,
  onRetrySetup,
}: WorktreeSetupInput): WorktreeSetupState | null {
  const { t } = useUiTranslation();
  const useWsMode = wsWorktreeStatus != null && wsWorktreeStatus !== "idle";
  const hasWsSetupOutput = (wsWorktreeSetupOutput?.length ?? 0) > 0;
  const shouldLoadSettings = !useWsMode || !hasWsSetupOutput;
  const { data: settingsArray } = useGetFeatureSettings(featureId, {
    query: { enabled: shouldLoadSettings },
  });
  const settings = useMemo(() => settingsArrayToMap(settingsArray), [settingsArray]);

  const step = useWsMode
    ? wsStatusToStep(wsWorktreeStatus!)
    : dbStepToSetupStep(settings?.worktree_setup_step);
  const branch = useWsMode ? (wsWorktreeBranch ?? "") : (settings?.worktree_branch ?? "");
  const setupError = useWsMode ? (wsWorktreeError ?? "") : (settings?.worktree_setup_error ?? "");

  const isDone = step === "done";
  const isError = step === "error";
  const health = useFeatureWorktreeInfo(featureId, projectId, isDone);
  const isMissing = Boolean(
    isDone && health.worktree && !health.worktree.is_main_worktree && !health.worktree.live,
  );
  const branchExists = health.worktree?.branch_exists ?? null;
  const displayStatus = displayStatusOf(step, isMissing, health.error != null, health.isLoading);
  const [isOpen, toggleOpen] = useWorktreeSetupDisclosure(featureId, useWsMode, step);
  const wsSetupLog = useMemo(
    () => (isOpen && hasWsSetupOutput ? (wsWorktreeSetupOutput ?? []).join("\n") : ""),
    [hasWsSetupOutput, isOpen, wsWorktreeSetupOutput],
  );
  const log = useWsMode
    ? wsSetupLog || (settings?.worktree_setup_log ?? "")
    : (settings?.worktree_setup_log ?? "");

  // Memoized, so a parent re-rendering on every stream delta hands the same
  // objects down (the header's Git host is memo'd on `header`).
  const header = useMemo<WorktreeSetupHeaderProps>(
    () => ({
      branch,
      branchExists,
      status: displayStatus,
      setupError,
      isOpen,
      onToggle: toggleOpen,
    }),
    [branch, branchExists, displayStatus, setupError, isOpen, toggleOpen],
  );
  const details = useMemo<WorktreeSetupDetailsProps | null>(
    () =>
      step
        ? {
            steps: buildSetupSteps(step, branch, t),
            branch,
            branchExists,
            healthError: health.error,
            isMissing,
            log,
            isError,
            setupError,
            onRetrySetup,
          }
        : null,
    [
      branch,
      branchExists,
      health.error,
      isError,
      isMissing,
      log,
      onRetrySetup,
      setupError,
      step,
      t,
    ],
  );
  return useMemo(() => (details ? { header, details } : null), [details, header]);
}
