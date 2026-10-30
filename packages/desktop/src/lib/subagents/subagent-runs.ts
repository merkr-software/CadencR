import { z } from "zod";
import type { SubagentRun } from "@/api/generated";

/**
 * Wire shape of `session.subagent_updated` (the backend's `SubagentRun`).
 * Validated at the WebSocket boundary; REST responses come typed from the
 * generated client.
 */
const subagentRunSchema = z.object({
  sessionId: z.number(),
  toolUseId: z.string(),
  parentToolUseId: z.string().nullish(),
  status: z.enum(["running", "completed", "failed", "stopped"]),
  statusReason: z.string().nullish(),
  agentType: z.string().nullish(),
  agentName: z.string().nullish(),
  description: z.string().nullish(),
  prompt: z.string().nullish(),
  model: z.string().nullish(),
  modelResolved: z.boolean(),
  reasoningEffort: z.string().nullish(),
  background: z.boolean(),
  childSessionId: z.string().nullish(),
  durationMs: z.number().nullish(),
  totalTokens: z.number().nullish(),
  toolUseCount: z.number().nullish(),
  resultSummary: z.string().nullish(),
  startedAt: z.string(),
  endedAt: z.string().nullish(),
  actionCount: z.number().nullish(),
});

export function parseSubagentRun(payload: unknown): SubagentRun | null {
  const parsed = subagentRunSchema.safeParse(payload);
  return parsed.success ? parsed.data : null;
}

/**
 * Fold a pushed run into a feature's list (newest first). A push carries no
 * transcript counts, so the listed ones are kept until the next fetch.
 */
export function upsertSubagentRun(runs: SubagentRun[], run: SubagentRun): SubagentRun[] {
  const index = runs.findIndex(
    (held) => held.toolUseId === run.toolUseId && held.sessionId === run.sessionId,
  );
  if (index === -1) return [run, ...runs];
  const held = runs[index];
  const merged: SubagentRun = {
    ...run,
    actionCount: run.actionCount ?? held.actionCount,
  };
  const next = runs.slice();
  next[index] = merged;
  return next;
}
