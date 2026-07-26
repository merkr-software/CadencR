/**
 * The chip row above the schedule's prompt.
 *
 * These are the session composer's own chips — the ones `MetaBar` renders —
 * driven from the schedule target instead of from a live session: the
 * collaboration mode, the branch/worktree behavior, the model and its thinking
 * effort, the provider access mode, and the Claude profile. Nothing here
 * re-implements a picker; this file only translates between the target's fields
 * and their props.
 *
 * What a run can actually change decides what is offered. A schedule that
 * creates the conversation owns every option. One that posts into an existing
 * conversation inherits that conversation's agent and working copy — the
 * backend drops both — but can still pin the rest, which dispatch writes onto
 * the session before sending.
 */
import { type ReactElement } from "react";
import type { ScheduleTarget } from "@/api/generated";
import { AccessModePopover } from "@/components/agent-session/AccessModePopover";
import { PermissionModeChip } from "@/components/agent-session/PermissionModeChip";
import { Skeleton } from "@/components/ui/skeleton";
import { useEnabledOptInModes } from "@/hooks/useEnabledOptInModes";
import { nextProviderMode } from "@/lib/provider-modes";
import { ScheduleModelChip, type ScheduleChipProps } from "./ScheduleModelChip";
import { ScheduleProfileChip } from "./ScheduleProfileChip";
import { ScheduleWorktreeChip } from "./ScheduleWorktreeChip";
import type { ScheduleRuntime } from "./useScheduleRuntime";

export interface ScheduleSettingsBarProps {
  target: ScheduleTarget;
  onChange: (next: ScheduleTarget) => void;
  /** Resolved by the composer, which also needs it to fetch the right command
   *  catalog — resolving it twice would just mean two identical passes. */
  runtime: ScheduleRuntime;
  /** Path of the target project — gates "reuse worktree" for the branch that is
   *  already checked out there. */
  projectPath?: string;
}

export function ScheduleSettingsBar({
  target,
  onChange,
  runtime,
  projectPath,
}: ScheduleSettingsBarProps): ReactElement {
  // Every chip below reads from `runtime`, and until it resolves those values
  // are fallbacks. Showing them would tell the user this run is configured one
  // way and then silently change the answer, so the row waits instead.
  if (runtime.isResolving) return <ChipRowSkeleton />;

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <ScheduleModeChip target={target} onChange={onChange} runtime={runtime} />
      {/* An existing conversation already has a working copy; only a schedule
          that creates one gets to choose. */}
      {target.kind === "new_conversation" && (
        <ScheduleWorktreeChip target={target} onChange={onChange} projectPath={projectPath} />
      )}
      <ScheduleModelChip target={target} onChange={onChange} runtime={runtime} />
      <ScheduleAccessChip target={target} onChange={onChange} runtime={runtime} />
      <ScheduleProfileChip target={target} onChange={onChange} runtime={runtime} />
    </div>
  );
}

/** Placeholders in the chips' own sizes, so the row doesn't jump when the real
 *  ones arrive. */
function ChipRowSkeleton(): ReactElement {
  return (
    <div
      className="flex flex-wrap items-center gap-1.5"
      aria-busy="true"
      aria-label="Loading schedule settings"
    >
      {[64, 96, 112, 72].map((width) => (
        <Skeleton key={width} className="h-6 rounded-full" style={{ width }} />
      ))}
    </div>
  );
}

/**
 * Clicking cycles, exactly as it does in the composer — the editor has no
 * Shift+Tab to bind, so the chip drops the shortcut hint and nothing else.
 */
function ScheduleModeChip({ target, onChange, runtime }: ScheduleChipProps): ReactElement | null {
  const enabledOptInModes = useEnabledOptInModes(runtime.providerId ?? "");
  return (
    <PermissionModeChip
      providerId={runtime.providerId}
      permissionMode={runtime.permissionMode}
      enabledOptInModes={enabledOptInModes}
      providerModes={runtime.provider?.modes}
      showShortcut={false}
      onToggle={() =>
        onChange({
          ...target,
          permission_mode: nextProviderMode(
            runtime.providerId,
            runtime.permissionMode,
            enabledOptInModes,
            runtime.provider?.modes,
          ),
        })
      }
    />
  );
}

/** Only rendered for providers that have an access axis at all. */
function ScheduleAccessChip({ target, onChange, runtime }: ScheduleChipProps): ReactElement | null {
  const options = runtime.provider?.access_modes ?? [];
  if (options.length === 0) return null;
  return (
    <AccessModePopover
      mode={runtime.accessMode}
      onChange={(accessMode) => onChange({ ...target, access_mode: accessMode })}
      providerId={runtime.providerId}
      options={options}
      description="Every run of this schedule uses the mode you pick here. It applies to this schedule only — conversations you start yourself keep their own."
      selectedHint="This schedule"
    />
  );
}
