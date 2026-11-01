/**
 * A turn's clock as the backend keeps it, and the lines that read it.
 *
 * The service's status book stamps a turn's start and the time it spends
 * waiting on its user; every device derives elapsed time from those instants
 * (converted through `server-clock`), so all of them show the same timer and
 * nothing ticks on the server. A finished turn's breakdown is persisted in the
 * transcript as a `turn_summary` row.
 */
import { serverToLocalMs } from "@/lib/server-clock";
import type { SessionStatusEntry } from "@/stores/session-status-store";

/** The running turn's clock, on the server's clock. */
export interface TurnClock {
  startedAtMs: number;
  waitingMs: number;
  waitingSinceMs: number | null;
  /** The model the CLI reports running the conversation's root agent. */
  model: string | null;
}

export interface TurnDurations {
  totalMs: number;
  waitingMs: number;
  agentMs: number;
}

/** The clock of a busy session's status entry; `null` without a known start. */
export function turnClockFromStatus(
  entry: SessionStatusEntry | null | undefined,
): TurnClock | null {
  if (!entry || entry.status === "idle" || entry.turnStartedAtMs == null) return null;
  return {
    startedAtMs: entry.turnStartedAtMs,
    waitingMs: entry.waitingMs ?? 0,
    waitingSinceMs: entry.waitingSinceMs ?? null,
    model: entry.model ?? null,
  };
}

/** Where the running turn stands at `nowMs` (this device's clock). */
export function elapsedTurnClock(clock: TurnClock, nowMs: number): TurnDurations {
  const totalMs = Math.max(0, nowMs - serverToLocalMs(clock.startedAtMs));
  const openWaitMs =
    clock.waitingSinceMs == null ? 0 : Math.max(0, nowMs - serverToLocalMs(clock.waitingSinceMs));
  const waitingMs = Math.min(totalMs, clock.waitingMs + openWaitMs);
  return { totalMs, waitingMs, agentMs: totalMs - waitingMs };
}

export function formatTurnDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1_000));
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);

  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (totalMinutes > 0) return `${totalMinutes}m ${seconds}s`;
  return `${seconds}s`;
}

/** "Working - <model> - <elapsed>", leaving out what is not known yet. */
export function formatWorkingLabel(model: string | null, elapsedMs: number | null): string {
  return ["Working", model, elapsedMs == null ? null : formatTurnDuration(elapsedMs)]
    .filter((part): part is string => !!part)
    .join(" - ");
}

/** A finished turn's breakdown, as its `turn_summary` row stores it. */
export interface TurnSummary extends TurnDurations {
  models: string[];
}

function finiteMs(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Parse a `turn_summary` row's content; `null` for a malformed row. */
export function parseTurnSummary(content: string): TurnSummary | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (parsed == null || typeof parsed !== "object") return null;
  const record = parsed as Record<string, unknown>;
  const totalMs = finiteMs(record.totalMs);
  if (totalMs == null) return null;
  const waitingMs = Math.min(totalMs, finiteMs(record.waitingMs) ?? 0);
  const models = Array.isArray(record.models)
    ? record.models.filter((model): model is string => typeof model === "string" && model !== "")
    : [];
  return { totalMs, waitingMs, agentMs: finiteMs(record.agentMs) ?? totalMs - waitingMs, models };
}

/** A closing line's parts, each already formatted. */
export interface WorkedParts {
  models: string | null;
  total: string;
  waiting: string;
  agent: string;
}

/**
 * The parts of "Worked - <model> - <total> - Waiting <w> - Agent <a>". They
 * are cut to whole seconds before splitting, so waiting and agent time add up
 * to the total shown.
 */
export function workedParts(summary: TurnSummary): WorkedParts {
  const totalMs = Math.floor(summary.totalMs / 1_000) * 1_000;
  const waitingMs = Math.min(totalMs, Math.floor(summary.waitingMs / 1_000) * 1_000);
  return {
    models: summary.models.length > 0 ? summary.models.join(" → ") : null,
    total: formatTurnDuration(totalMs),
    waiting: formatTurnDuration(waitingMs),
    agent: formatTurnDuration(totalMs - waitingMs),
  };
}

export function formatWorkedLabel(summary: TurnSummary): string {
  const { models, total, waiting, agent } = workedParts(summary);
  return ["Worked", models, total, `Waiting ${waiting}`, `Agent ${agent}`]
    .filter((part): part is string => !!part)
    .join(" - ");
}

/** A `model_switch` row's content: the model the CLI moved from and to. */
export function parseModelSwitch(content: string): { from: string; to: string } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (parsed == null || typeof parsed !== "object") return null;
  const { from, to } = parsed as Record<string, unknown>;
  return typeof from === "string" && typeof to === "string" ? { from, to } : null;
}
