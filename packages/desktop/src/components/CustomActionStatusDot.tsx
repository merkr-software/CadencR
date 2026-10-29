import { cn } from "@/lib/utils";
import type { LastRunSummary } from "@/api/generated";

interface CustomActionStatusDotProps {
  lastRun: LastRunSummary | null;
  isRunning: boolean;
  className?: string;
}

interface CustomActionStatus {
  /** Human-readable status, used in accessible names and tooltips. */
  label: string;
  /** Dot color classes, or null when there is nothing worth signalling. */
  color: string | null;
}

/**
 * Derive an action's run status. Server-side a run is "running" when
 * `ended_at` is null; `CustomAction.last_run` embeds the same shape, so derive
 * locally rather than asking the backend for a separate flag.
 */
export function customActionStatus(
  lastRun: LastRunSummary | null,
  isRunning: boolean,
): CustomActionStatus {
  if (isRunning || (lastRun != null && lastRun.ended_at == null)) {
    return { label: "Running…", color: "bg-amber-500 animate-pulse" };
  }
  if (lastRun?.exit_code == null) return { label: "Never run", color: null };
  if (lastRun.exit_code === 0) return { label: "Last run succeeded", color: "bg-emerald-500" };
  return { label: `Last run failed (exit ${lastRun.exit_code})`, color: "bg-red-500" };
}

/**
 * Tiny dot rendered on top of an action's icon: pulsing amber while running,
 * green after a successful run, red after a failed one. Nothing is drawn for an
 * action that has never run. Decorative: the owning control carries the status
 * in its accessible name (see `customActionStatus`).
 */
export function CustomActionStatusDot({
  lastRun,
  isRunning,
  className,
}: CustomActionStatusDotProps) {
  const { color } = customActionStatus(lastRun, isRunning);
  if (color == null) return null;
  return (
    <span
      aria-hidden
      className={cn(
        "absolute -bottom-0.5 -right-0.5 size-2 rounded-full ring-1 ring-background",
        color,
        className,
      )}
    />
  );
}
