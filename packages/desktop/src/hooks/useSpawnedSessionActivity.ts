import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getAgentActivityDigest, type AgentActivityDigestEntry } from "@/api/generated";
import type { LiveAgentStatus } from "@/types/agent";
import type { AgentBlockData } from "@/types/agent-block";

/** The notch island's cadence: the digest is one indexed seek per conversation. */
const ACTIVITY_POLL_MS = 2_500;

export interface SpawnedSessionActivity {
  /** The latest step, after the one it replaced so the head line can hand over. */
  steps: AgentBlockData[];
  /** Start of the agent's latest reply. */
  reply: string | null;
  isLoading: boolean;
  error: unknown;
}

/**
 * What a spawned conversation is doing, for its card in the parent's stream:
 * its latest top-level tool call and reply, read from the activity digest.
 * Polls only while that agent works (a mounted card only: the stream is
 * virtualized), and a status flip refetches at once so a finished agent shows
 * its final reply. One cache entry per conversation, never fresh for long: a
 * status-keyed entry served a turn-old reply when the agent ran again.
 */
export function useSpawnedSessionActivity(
  featureId: number,
  status: LiveAgentStatus,
): SpawnedSessionActivity {
  const query = useQuery({
    queryKey: ["spawned-session-activity", featureId],
    queryFn: async ({ signal }) => {
      const digest = await getAgentActivityDigest({ feature_ids: String(featureId) }, signal);
      return digest.entries.find((entry) => entry.feature_id === featureId) ?? null;
    },
    staleTime: 0,
    refetchInterval: status === "agent" ? ACTIVITY_POLL_MS : false,
  });
  const { refetch } = query;
  const seenStatus = useRef(status);
  useEffect(() => {
    if (seenStatus.current === status) return;
    seenStatus.current = status;
    void refetch();
  }, [refetch, status]);
  const steps = useStepHistory(featureId, query.data);
  return useMemo(
    () => ({
      steps,
      reply: query.data?.last_reply?.trim() || null,
      isLoading: query.isLoading,
      error: query.error,
    }),
    [steps, query.data, query.isLoading, query.error],
  );
}

/** Keeps the step a new one replaces, so the latest-action line animates the swap. */
function useStepHistory(
  featureId: number,
  entry: AgentActivityDigestEntry | null | undefined,
): AgentBlockData[] {
  const latest = useMemo(() => stepBlock(featureId, entry), [featureId, entry]);
  const [history, setHistory] = useState<AgentBlockData[]>(() => (latest ? [latest] : []));
  const newest = history.at(-1);
  if (latest && latest.id !== newest?.id) {
    setHistory(newest ? [newest, latest] : [latest]);
  }
  return history;
}

function stepBlock(
  featureId: number,
  entry: AgentActivityDigestEntry | null | undefined,
): AgentBlockData | null {
  const tool = entry?.last_tool;
  if (!tool) return null;
  return {
    // The digest carries no message id: the call itself identifies the step.
    id: `spawned-${featureId}:${tool.name}:${tool.args}`,
    type: "tool_call",
    content: "",
    toolName: tool.name,
    toolArgs: tool.args,
  };
}
