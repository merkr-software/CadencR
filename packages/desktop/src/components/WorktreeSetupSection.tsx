import { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronRightIcon,
  CheckCircle2Icon,
  Loader2Icon,
  AlertCircleIcon,
  GitBranchIcon,
  RefreshCwIcon,
} from "lucide-react";
import { useGetFeatureSettings } from "@/api/generated";
import { settingsArrayToMap } from "@/api/settings";
import type { WorktreeStatus } from "@/types/workflow";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/CopyButton";
import { BashBlock } from "@/components/BashBlock";
import { cn } from "@/lib/utils";

type SetupStep = "naming" | "named" | "creating" | "created" | "setup" | "done" | "error";

const STEP_ORDER: SetupStep[] = ["naming", "named", "creating", "created", "setup", "done"];

function stepIndex(step: SetupStep): number {
  const idx = STEP_ORDER.indexOf(step);
  return idx >= 0 ? idx : -1;
}

function StepIcon({
  complete,
  active,
  error,
}: {
  complete: boolean;
  active: boolean;
  error: boolean;
}) {
  if (error) return <AlertCircleIcon className="size-4 text-red-400" />;
  if (complete) return <CheckCircle2Icon className="size-4 text-green-500" />;
  if (active) return <Loader2Icon className="size-4 animate-spin text-blue-400" />;
  return <div className="size-4 rounded-full border border-muted-foreground/30" />;
}

function LogOutput({ log }: { log: string }) {
  return (
    <BashBlock
      command="Setup — worktree commands"
      content={log}
      bodyExtraClassName="max-h-40 overflow-y-auto"
    />
  );
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

export function WorktreeSetupSection({
  featureId,
  projectId: _projectId,
  wsWorktreeStatus,
  wsWorktreeBranch,
  wsWorktreeSetupOutput,
  wsWorktreeError,
  onRetrySetup,
}: {
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
}) {
  const useWsMode = wsWorktreeStatus != null && wsWorktreeStatus !== "idle";
  const hasWsSetupOutput = (wsWorktreeSetupOutput?.length ?? 0) > 0;
  const shouldLoadSettings = !useWsMode || !hasWsSetupOutput;
  const wsSetupLog = useMemo(
    () => (hasWsSetupOutput ? (wsWorktreeSetupOutput ?? []).join("\n") : ""),
    [hasWsSetupOutput, wsWorktreeSetupOutput],
  );

  const { data: settingsArray } = useGetFeatureSettings(featureId, {
    query: { enabled: shouldLoadSettings },
  });
  const settings = useMemo(() => settingsArrayToMap(settingsArray), [settingsArray]);

  const retryWorktreeSetup = onRetrySetup;

  const step = useWsMode
    ? wsStatusToStep(wsWorktreeStatus!)
    : dbStepToSetupStep(settings?.worktree_setup_step);
  const log = useWsMode
    ? wsSetupLog || (settings?.worktree_setup_log ?? "")
    : (settings?.worktree_setup_log ?? "");
  const branch = useWsMode ? (wsWorktreeBranch ?? "") : (settings?.worktree_branch ?? "");
  const setupError = useWsMode ? (wsWorktreeError ?? "") : (settings?.worktree_setup_error ?? "");

  const isDone = step === "done";
  const isError = step === "error";
  const isRunning = !!step && !isDone && !isError;

  // Force open during setup/error; auto-collapse 5s after a fresh "done";
  // pre-existing "done" on mount stays collapsed (skipped via didObserveStepRef).
  const [userToggle, setUserToggle] = useState<boolean | null>(null);
  const previousStepRef = useRef<SetupStep | null>(null);
  const didObserveStepRef = useRef(false);
  useEffect(() => {
    setUserToggle(null);
    previousStepRef.current = null;
    didObserveStepRef.current = false;
  }, [featureId, useWsMode]);
  useEffect(() => {
    if (!step) return;
    const previousStep = previousStepRef.current;
    previousStepRef.current = step;
    if (!didObserveStepRef.current) {
      didObserveStepRef.current = true;
      return;
    }
    if (previousStep === step) return;
    if (step === "setup" || step === "error") {
      setUserToggle(true);
    }
    if (step === "done" && previousStep !== "done") {
      const timer = setTimeout(() => setUserToggle(false), 5000);
      return () => clearTimeout(timer);
    }
  }, [step]);
  const isOpen = userToggle ?? isRunning;

  // Don't render if setup hasn't started
  if (!step) return null;

  const currentStep = stepIndex(step);

  // Worktree exists if we have a branch (naming + creation succeeded)
  const worktreeCreated = !!branch;

  // Steps UI data
  const steps = [
    {
      label: "Define name",
      complete: worktreeCreated || currentStep >= 1,
      active: step === "naming",
      error: false,
    },
    {
      label: "Create worktree",
      complete: worktreeCreated || currentStep >= 3,
      active: step === "creating",
      error: false, // worktree creation errors are fatal, not retryable here
      detail: branch ? branch : undefined,
    },
    {
      label: "Run setup commands",
      complete: isDone,
      active: step === "setup",
      error: isError,
      showLog: true,
    },
  ];

  return (
    <div className="flex flex-col bg-background" data-worktree-setup>
      {/* Header — compact inline row. `min-w-0` + the per-child `shrink-0`
          guards keep everything on one line: only the branch name shrinks and
          truncates, so a long branch can never wrap the row to two lines. */}
      <div
        className="flex min-w-0 cursor-pointer items-center gap-2 px-3 py-1.5 hover:bg-muted/70 md:px-6"
        onClick={() => setUserToggle((prev) => !(prev ?? isOpen))}
      >
        <ChevronRightIcon
          className={cn(
            "size-3.5 shrink-0 text-foreground/40 transition-transform duration-200",
            isOpen && "rotate-90",
          )}
        />
        <GitBranchIcon className="size-3.5 shrink-0" />
        <span className="shrink-0 text-xs font-medium">Worktree Setup</span>
        {/* The branch + status badge share one `flex-1` wrapper so the wrapper
            gets a bounded width (mobile truncation still works), while the badge
            stays glued to the branch name instead of being flushed to the row's
            far right on wide desktop viewports. */}
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {branch && (
            <div className="flex min-w-0 items-center gap-1.5">
              <span className="truncate text-xs font-mono text-muted-foreground">{branch}</span>
              <CopyButton
                text={branch}
                label="Copy branch name"
                copiedLabel="Copied branch name"
                idleClassName="text-muted-foreground opacity-70"
                iconClassName="size-3"
                className="shrink-0 hover:text-foreground"
              />
            </div>
          )}
          <Badge
            variant="secondary"
            className={cn(
              "shrink-0 gap-1 text-[10px] px-1.5 py-0",
              isDone && "bg-green-500/15 text-green-400",
              isRunning && "bg-blue-500/15 text-blue-400",
              isError && "bg-red-500/15 text-red-400",
            )}
          >
            {isDone && (
              <>
                <CheckCircle2Icon className="size-2.5" />
                ready
              </>
            )}
            {isRunning && (
              <>
                <Loader2Icon className="size-2.5 animate-spin" />
                running
              </>
            )}
            {isError && (
              <>
                <AlertCircleIcon className="size-2.5" />
                error
              </>
            )}
          </Badge>
        </div>
      </div>

      {/* Expanded details */}
      {isOpen && (
        <div className="space-y-1.5 border-t border-border/50 px-3 py-2 md:px-6">
          {steps.map((s, i) => (
            <div key={i} className="flex items-start gap-2">
              <div className="mt-0.5">
                <StepIcon complete={s.complete} active={s.active} error={s.error} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-[10px] text-muted-foreground">{i + 1}.</span>
                  <span className="text-xs">{s.label}</span>
                  {s.detail && (
                    <span className="text-[10px] text-muted-foreground font-mono truncate">
                      {s.detail}
                    </span>
                  )}
                </div>
                {s.showLog && log && (s.active || s.complete || s.error) && <LogOutput log={log} />}
              </div>
            </div>
          ))}

          {isError && (
            <div className="flex min-w-0 items-center gap-2 pt-0.5">
              <Button
                variant="outline"
                size="sm"
                type="button"
                className="h-6 gap-1.5 text-xs"
                onClick={retryWorktreeSetup}
              >
                <RefreshCwIcon className="size-3" />
                Retry
              </Button>
              {setupError && (
                <p className="min-w-0 truncate text-xs text-red-400" title={setupError}>
                  {setupError}
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
