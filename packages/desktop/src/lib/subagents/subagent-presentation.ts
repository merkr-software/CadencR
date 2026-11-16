import type { SubagentRun, SubagentRunStatus } from "@/api/generated";
import { formatCompactTokens } from "@/components/usage/usage-chart-palette";
import { parseToolArgsObject, stringArg } from "@/lib/tool-args";
import { parseUTCDateTime } from "@/lib/date-utils";
import { serverToLocalMs } from "@/lib/server-clock";

/**
 * What a sub-agent row shows, from its registry run when the backend has one
 * and from the carrier block's own input otherwise (a run is pushed right
 * after its carrier, and history predating the registry is derived server
 * side, so the fallback only bridges the first paint).
 */
export interface SubagentView {
  status: SubagentRunStatus;
  /** The agent's name: its instance name, else its definition, else the tool. */
  title: string;
  description: string | null;
  model: string | null;
  /** The model is only what was asked for; it has not reported running yet. */
  modelRequested: boolean;
  effort: string | null;
  background: boolean;
  totalTokens: number | null;
  toolUseCount: number | null;
  statusReason: string | null;
  resultSummary: string | null;
  prompt: string | null;
  startedAtMs: number | null;
  endedAtMs: number | null;
  durationMs: number | null;
}

interface CarrierLike {
  toolName?: string;
  toolArgs?: string;
  taskComplete?: boolean;
}

export function subagentView(run: SubagentRun | undefined, carrier?: CarrierLike): SubagentView {
  const args = parseToolArgsObject(carrier?.toolArgs);
  const arg = (key: string): string | null => stringArg(args, key) ?? null;
  const fallbackTitle = arg("subagent_type") ?? arg("subagentType") ?? carrier?.toolName ?? "Agent";
  const title = run?.agentName ?? run?.agentType ?? fallbackTitle;
  const description = run?.description ?? arg("description");
  return {
    status: run?.status ?? (carrier?.taskComplete ? "completed" : "running"),
    title,
    // Some providers name an agent after its task: say it once.
    description: description && description.trim() !== title ? description : null,
    model: run?.model ?? arg("model"),
    modelRequested: run ? !run.modelResolved : true,
    effort: run?.reasoningEffort ?? arg("effort"),
    background: run?.background ?? false,
    totalTokens: run?.totalTokens ?? null,
    toolUseCount: run?.toolUseCount ?? null,
    statusReason: run?.statusReason ?? null,
    resultSummary: run?.resultSummary ?? null,
    prompt: run?.prompt ?? arg("prompt"),
    startedAtMs: timestampMs(run?.startedAt),
    endedAtMs: timestampMs(run?.endedAt),
    durationMs: run?.durationMs ?? null,
  };
}

/**
 * How many actions to show: the provider's own count, else the most the
 * transcript shows (the loaded children or the listed count). `null` for none.
 */
export function subagentActionCount(
  view: SubagentView,
  transcript: { shown?: number; listed?: number | null },
): number | null {
  const count = view.toolUseCount ?? Math.max(transcript.shown ?? 0, transcript.listed ?? 0);
  return count > 0 ? count : null;
}

/** A server-stamped instant on this device's clock, so a running clock agrees across devices. */
function timestampMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = parseUTCDateTime(value).getTime();
  return Number.isFinite(ms) ? serverToLocalMs(ms) : null;
}

/** Elapsed time: the reported duration once ended, the live span while running. */
export function subagentElapsedMs(view: SubagentView, nowMs: number): number | null {
  if (view.status !== "running") {
    if (view.durationMs != null) return view.durationMs;
    if (view.startedAtMs != null && view.endedAtMs != null) {
      return Math.max(0, view.endedAtMs - view.startedAtMs);
    }
    return null;
  }
  return view.startedAtMs == null ? null : Math.max(0, nowMs - view.startedAtMs);
}

export function formatTokens(tokens: number): string {
  return `${formatCompactTokens(tokens)} tok`;
}

export const STATUS_LABEL: Record<SubagentRunStatus, string> = {
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  stopped: "Stopped",
};

const REASON_LABEL: Record<string, string> = {
  interrupted: "Interrupted",
  turn_failed: "Turn failed",
  runtime_ended: "Agent process ended",
  service_restarted: "Cadencr restarted",
  closed: "Closed by its parent",
  killed: "Killed",
  not_found: "Not found",
};

/** Human words for why a sub-agent stopped; provider errors pass through. */
export function statusReasonLabel(reason: string | null): string | null {
  if (!reason) return null;
  return REASON_LABEL[reason] ?? reason;
}

/** Sentence for screen readers and tooltips. */
export function subagentStatusSentence(view: SubagentView): string {
  const reason = statusReasonLabel(view.statusReason);
  return reason ? `${STATUS_LABEL[view.status]} · ${reason}` : STATUS_LABEL[view.status];
}
