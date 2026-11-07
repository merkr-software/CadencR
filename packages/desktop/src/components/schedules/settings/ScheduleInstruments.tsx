/**
 * The instrument row under the schedule's prompt.
 *
 * These are the session composer's own instruments — mode │ model · effort │
 * access on the left, the Claude profile on the right — driven from the
 * schedule target instead of from a live session. Nothing here re-implements a
 * picker; this file only translates between the target's fields and their
 * props. The branch/worktree choice is the card's launch line
 * (`ScheduleLaunchManifest`), as on a first prompt.
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
import { ModeControl } from "@/components/composer/ModeControl";
import { Skeleton } from "@/components/ui/skeleton";
import { useEnabledOptInModes } from "@/hooks/useEnabledOptInModes";
import { ScheduleModelChip, type ScheduleChipProps } from "./ScheduleModelChip";
import { ScheduleProfileChip } from "./ScheduleProfileChip";
import type { ScheduleRuntime } from "./useScheduleRuntime";

export interface ScheduleInstrumentsProps {
  target: ScheduleTarget;
  onChange: (next: ScheduleTarget) => void;
  /** Resolved by the composer, which also needs it to fetch the right command
   *  catalog — resolving it twice would just mean two identical passes. */
  runtime: ScheduleRuntime;
}

// Like the composer's own row, the session controls never wrap among
// themselves (a wrapped group would open its line with a hairline); when the
// profile no longer fits beside them, it takes a line of its own.
const ROW_CLASS = "@container flex shrink-0 flex-wrap items-center gap-1.5 px-2 pb-2";

export function ScheduleInstruments({
  target,
  onChange,
  runtime,
}: ScheduleInstrumentsProps): ReactElement {
  // Every instrument below reads from `runtime`, and until it resolves those
  // values are fallbacks. Showing them would tell the user this run is
  // configured one way and then silently change the answer, so the row waits.
  if (runtime.isResolving) return <InstrumentRowSkeleton />;

  const chip = { target, onChange, runtime };
  return (
    <div data-composer-instruments className={ROW_CLASS}>
      {/* Each control sits in a composer group, so the composer's hairlines
          separate them. */}
      <div data-composer-zone className="flex min-w-0 items-center gap-0.5 overflow-hidden">
        <span data-composer-group className="flex items-center">
          <ScheduleModeControl {...chip} />
        </span>
        <span data-composer-group className="flex items-center">
          <ScheduleModelChip {...chip} />
        </span>
        <span data-composer-group className="flex items-center">
          <ScheduleAccessControl {...chip} />
        </span>
      </div>
      <div data-composer-zone className="ml-auto flex min-w-0 items-center gap-1.5">
        <ScheduleProfileChip {...chip} />
      </div>
    </div>
  );
}

/** Placeholders in the instruments' own sizes, so the row doesn't jump when
 *  the real ones arrive. */
function InstrumentRowSkeleton(): ReactElement {
  return (
    <div className={ROW_CLASS} aria-busy="true" aria-label="Loading schedule settings">
      {[64, 112, 72].map((width) => (
        <Skeleton key={width} className="h-7 rounded-md" style={{ width }} />
      ))}
    </div>
  );
}

/**
 * The composer's autonomy menu. The editor has no Shift+Tab to bind, so the
 * menu drops the shortcut hint.
 */
function ScheduleModeControl({
  target,
  onChange,
  runtime,
}: ScheduleChipProps): ReactElement | null {
  const enabledOptInModes = useEnabledOptInModes(runtime.providerId ?? "");
  return (
    <ModeControl
      providerId={runtime.providerId}
      permissionMode={runtime.permissionMode}
      enabledOptInModes={enabledOptInModes}
      providerModes={runtime.provider?.modes}
      showShortcut={false}
      onSelect={(permissionMode) => onChange({ ...target, permission_mode: permissionMode })}
    />
  );
}

/** Only rendered for providers that have an access axis at all. */
function ScheduleAccessControl({
  target,
  onChange,
  runtime,
}: ScheduleChipProps): ReactElement | null {
  const options = runtime.provider?.access_modes ?? [];
  if (options.length === 0) return null;
  return (
    <AccessModePopover
      variant="instrument"
      mode={runtime.accessMode}
      onChange={(accessMode) => onChange({ ...target, access_mode: accessMode })}
      providerId={runtime.providerId}
      options={options}
      description="Every run of this schedule uses the mode you pick here. It applies to this schedule only — conversations you start yourself keep their own."
      selectedHint="This schedule"
    />
  );
}
