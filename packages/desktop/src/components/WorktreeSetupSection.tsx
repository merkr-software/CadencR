import type { ReactElement, ReactNode } from "react";
import {
  CheckCircle2Icon,
  Loader2Icon,
  AlertCircleIcon,
  AlertTriangleIcon,
  RefreshCwIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { BashBlock } from "@/components/BashBlock";
import { WorktreeSetupHeader } from "@/components/WorktreeSetupHeader";
import {
  useWorktreeSetup,
  type SetupStepItem,
  type WorktreeSetupDetailsProps,
  type WorktreeSetupInput,
} from "@/hooks/useWorktreeSetup";

function StepIcon({
  complete,
  active,
  error,
}: {
  complete: boolean;
  active: boolean;
  error: boolean;
}): ReactElement {
  if (error) return <AlertCircleIcon className="size-4 text-red-400" />;
  if (complete) return <CheckCircle2Icon className="size-4 text-green-500" />;
  if (active) return <Loader2Icon className="size-4 animate-spin text-blue-400" />;
  return <div className="size-4 rounded-full border border-muted-foreground/30" />;
}

function LogOutput({ log }: { log: string }): ReactElement {
  return (
    <BashBlock
      command="Setup — worktree commands"
      content={log}
      bodyExtraClassName="max-h-40 overflow-y-auto"
    />
  );
}

function WorktreeSetupFrame({ children }: { children: ReactNode }): ReactElement {
  return (
    <div className="flex flex-col bg-background" data-worktree-setup>
      {children}
    </div>
  );
}

export function WorktreeSetupSection(props: WorktreeSetupInput): ReactElement | null {
  const setup = useWorktreeSetup(props);
  if (!setup) return null;
  return (
    <WorktreeSetupFrame>
      <WorktreeSetupHeader {...setup.header} className="px-3 py-1.5 md:px-6" />
      {setup.header.isOpen && <WorktreeSetupDetails {...setup.details} />}
    </WorktreeSetupFrame>
  );
}

export function WorktreeSetupDetailsPanel(props: WorktreeSetupDetailsProps): ReactElement {
  return (
    <WorktreeSetupFrame>
      <WorktreeSetupDetails {...props} />
    </WorktreeSetupFrame>
  );
}

function WorktreeSetupDetails({
  branch,
  branchExists,
  healthError,
  isMissing,
  steps,
  log,
  isError,
  setupError,
  onRetrySetup,
}: WorktreeSetupDetailsProps): ReactElement {
  return (
    <div className="space-y-1.5 border-t border-border/50 px-3 py-2 md:px-6">
      {isMissing && <MissingWorktreeWarning branch={branch} branchExists={branchExists} />}
      {healthError != null && (
        <div className="flex gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
          <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
          <span>Could not verify whether the worktree and branch still exist.</span>
        </div>
      )}
      {steps.map((step, index) => (
        <WorktreeSetupStep key={step.label} index={index} log={log} step={step} />
      ))}
      {isError && <WorktreeSetupRetry setupError={setupError} onRetrySetup={onRetrySetup} />}
    </div>
  );
}

function MissingWorktreeWarning({
  branch,
  branchExists,
}: {
  branch: string;
  branchExists: boolean | null;
}): ReactElement {
  const branchStatus =
    branchExists === true
      ? `The branch ${branch || "recorded for this session"} still exists.`
      : branchExists === false
        ? `The branch ${branch || "recorded for this session"} was also removed.`
        : "The branch status could not be determined.";
  return (
    <div className="flex gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
      <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
      <span>
        This worktree was removed from the machine. {branchStatus} Cadencr is using the project
        folder instead.
      </span>
    </div>
  );
}

function WorktreeSetupStep({
  index,
  log,
  step,
}: {
  index: number;
  log: string;
  step: SetupStepItem;
}): ReactElement {
  return (
    <div className="flex items-start gap-2">
      <div className="mt-0.5">
        <StepIcon complete={step.complete} active={step.active} error={step.error} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-muted-foreground">{index + 1}.</span>
          <span className="text-xs">{step.label}</span>
          {step.detail && (
            <span className="text-[10px] text-muted-foreground font-mono truncate">
              {step.detail}
            </span>
          )}
        </div>
        {step.showLog && log && (step.active || step.complete || step.error) && (
          <LogOutput log={log} />
        )}
      </div>
    </div>
  );
}

function WorktreeSetupRetry({
  setupError,
  onRetrySetup,
}: {
  setupError: string;
  onRetrySetup?: () => void;
}): ReactElement {
  return (
    <div className="flex min-w-0 items-center gap-2 pt-0.5">
      <Button
        variant="outline"
        size="sm"
        type="button"
        className="h-6 gap-1.5 text-xs"
        onClick={onRetrySetup}
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
  );
}
