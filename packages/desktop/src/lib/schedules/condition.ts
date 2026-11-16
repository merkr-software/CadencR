/**
 * The command a schedule can be gated on: at each scheduled time the command
 * runs in the target's working copy, and the prompt is only sent when it exits
 * non-zero. Bounds mirror `schedules/condition.rs`.
 */
import type { ScheduleCondition, ScheduleLastCheck } from "@/api/generated";
import { formatAbsolute } from "./format";

export const DEFAULT_CONDITION_TIMEOUT_SECONDS = 300;
export const MAX_CONDITION_TIMEOUT_SECONDS = 600;

export interface ConditionDraft {
  enabled: boolean;
  command: string;
  timeoutSeconds: number;
}

export function toConditionDraft(condition?: ScheduleCondition | null): ConditionDraft {
  return {
    enabled: Boolean(condition),
    command: condition?.command ?? "",
    timeoutSeconds: condition?.timeout_seconds ?? DEFAULT_CONDITION_TIMEOUT_SECONDS,
  };
}

/** `null` turns the condition off: the save replaces the whole rule. */
export function conditionDraftToInput(draft: ConditionDraft): ScheduleCondition | null {
  if (!draft.enabled) return null;
  return {
    command: draft.command.trim(),
    // The default isn't stored, so the service can move it without a migration.
    timeout_seconds:
      draft.timeoutSeconds === DEFAULT_CONDITION_TIMEOUT_SECONDS ? null : draft.timeoutSeconds,
  };
}

export function conditionDraftError(draft: ConditionDraft): string | null {
  if (!draft.enabled) return null;
  if (!draft.command.trim()) return "Enter the command to check.";
  if (
    !Number.isInteger(draft.timeoutSeconds) ||
    draft.timeoutSeconds < 1 ||
    draft.timeoutSeconds > MAX_CONDITION_TIMEOUT_SECONDS
  ) {
    return `The timeout must be between 1 and ${MAX_CONDITION_TIMEOUT_SECONDS} seconds.`;
  }
  return null;
}

/**
 * The latest evaluation as a sentence, e.g. `Check passed Today at 9:00 AM`.
 * A triggered check doesn't claim the prompt arrived: the check is recorded
 * before delivery, and the last-run line reports how delivery went.
 */
export function describeLastCheck(check: ScheduleLastCheck): string {
  const at = formatAbsolute(new Date(check.at));
  switch (check.status) {
    case "passed":
      return `Check passed ${at} — nothing sent`;
    case "triggered":
      return check.exit_code == null
        ? `Command was killed ${at}`
        : `Command failed (exit ${check.exit_code}) ${at}`;
    case "busy":
      return `Skipped ${at} — the agent was busy`;
    case "error":
      return `Command could not run ${at}`;
  }
}
