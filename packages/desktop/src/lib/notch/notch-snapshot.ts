import type { AgentActivityDigestEntry } from "@/api/generated";
import type { LiveAgentStatus, PendingKind } from "@/types/agent";
import { NOTCH_MAX_AGENTS, type NotchAgent, type NotchSnapshot } from "@/shared/notch";
import { serverToLocalMs } from "@/lib/server-clock";
import { notchActionKind, notchActionLabel, plainPreview } from "./notch-action";

/**
 * Pure composition of the notch island's snapshot from the app's own state:
 * live status (the session-status store — the only source of "is it
 * working?"), the agents that finished during this run, the unread set, and
 * the activity digest that carries titles, last actions and reply previews.
 */

export interface FeatureLiveStatus {
  status: LiveAgentStatus;
  kind: PendingKind | null;
  turnStartedAtMs: number | null;
}

export interface NotchProviderVisual {
  label: string;
  iconSrc: string | null;
  mono: boolean;
}

/** What decides which features the island lists. */
export interface NotchTrackingInput {
  live: ReadonlyMap<number, FeatureLiveStatus>;
  /** Features whose turn finished during this run → finish time (epoch ms). */
  finishedAt: Readonly<Record<number, number>>;
  unread: Readonly<Record<number, true>>;
  /** Feature → when the user cleared it from the island. A later finish re-lists it. */
  dismissedAt: Readonly<Record<number, number>>;
  now: number;
}

export interface NotchComposeInput extends NotchTrackingInput {
  digest: readonly AgentActivityDigestEntry[];
  provider: (providerId: string | null | undefined) => NotchProviderVisual | null;
}

/** A read, finished agent stays listed this long; an unread one until it is read. */
export const NOTCH_DONE_TTL_MS = 45 * 60_000;
const MAX_DONE = 6;

/** Aggregate per-session entries into one status per feature (question > agent > idle). */
export function aggregateFeatureStatuses(
  bySession: Readonly<
    Record<
      number,
      {
        featureId: number;
        status: LiveAgentStatus;
        kind: PendingKind | null;
        turnStartedAtMs?: number | null;
      }
    >
  >,
): Map<number, FeatureLiveStatus> {
  const byFeature = new Map<number, FeatureLiveStatus>();
  const rank = { idle: 0, agent: 1, question: 2 } as const;
  for (const entry of Object.values(bySession)) {
    const current = byFeature.get(entry.featureId);
    if (current && rank[current.status] >= rank[entry.status]) continue;
    byFeature.set(entry.featureId, {
      status: entry.status,
      kind: entry.status === "question" ? entry.kind : null,
      turnStartedAtMs: entry.turnStartedAtMs ?? null,
    });
  }
  return byFeature;
}

function isDismissed(input: NotchTrackingInput, featureId: number): boolean {
  const dismissed = input.dismissedAt[featureId];
  if (dismissed == null) return false;
  return dismissed >= (input.finishedAt[featureId] ?? 0);
}

/** Finished features worth listing: unread first (they survive the cap), then most recent. */
function doneFeatureIds(input: NotchTrackingInput): number[] {
  const candidates = new Set<number>();
  for (const id of Object.keys(input.unread)) candidates.add(Number(id));
  for (const [id, at] of Object.entries(input.finishedAt)) {
    if (input.now - at <= NOTCH_DONE_TTL_MS) candidates.add(Number(id));
  }
  return [...candidates]
    .filter((id) => {
      const status = input.live.get(id)?.status ?? "idle";
      return status === "idle" && !isDismissed(input, id);
    })
    .sort((a, b) => {
      const byUnread = Number(input.unread[b] === true) - Number(input.unread[a] === true);
      if (byUnread !== 0) return byUnread;
      return (input.finishedAt[b] ?? 0) - (input.finishedAt[a] ?? 0);
    })
    .slice(0, MAX_DONE);
}

/** Every feature the island should show — also the digest request's id list. */
export function notchTrackedFeatureIds(input: NotchTrackingInput): number[] {
  const active: number[] = [];
  for (const [featureId, live] of input.live) {
    if (live.status !== "idle") active.push(featureId);
  }
  return [...active, ...doneFeatureIds(input)].slice(0, NOTCH_MAX_AGENTS);
}

function statusOf(live: FeatureLiveStatus | undefined): NotchAgent["status"] {
  if (live?.status === "question") return "question";
  if (live?.status === "agent") return "running";
  return "done";
}

function parseIsoMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

function toAgent(input: NotchComposeInput, entry: AgentActivityDigestEntry): NotchAgent {
  const live = input.live.get(entry.feature_id);
  const status = statusOf(live);
  const provider = input.provider(entry.provider);
  const tool = entry.last_tool;
  return {
    featureId: entry.feature_id,
    projectId: entry.project_id,
    title: entry.feature_title.trim() || "Untitled conversation",
    projectName: entry.project_name,
    status,
    pendingKind: status === "question" ? (live?.kind ?? null) : null,
    providerLabel: provider?.label ?? null,
    providerIconSrc: provider?.iconSrc ?? null,
    providerIconMono: provider?.mono ?? false,
    // Server-stamped; the island measures against this machine's clock.
    turnStartedAtMs:
      status === "done" || live?.turnStartedAtMs == null
        ? null
        : serverToLocalMs(live.turnStartedAtMs),
    lastActivityAtMs:
      status === "done"
        ? (input.finishedAt[entry.feature_id] ?? parseIsoMs(entry.last_activity_at))
        : parseIsoMs(entry.last_activity_at),
    lastAction: tool
      ? {
          kind: notchActionKind(tool.name, tool.args),
          label: notchActionLabel(tool.name, tool.args),
        }
      : null,
    preview: entry.last_reply ? plainPreview(entry.last_reply) || null : null,
    unread: input.unread[entry.feature_id] === true,
  };
}

/**
 * How soon an agent needs you, lowest first: a permission request (the agent
 * is blocked on a yes/no), a question, an unread reply, then agents still at
 * work, and last the finished ones you have already read.
 */
function notchAttentionRank(agent: NotchAgent): number {
  if (agent.status === "question") return agent.pendingKind === "permission" ? 0 : 1;
  if (agent.status === "done") return agent.unread ? 2 : 4;
  return 3;
}

function compareAgents(a: NotchAgent, b: NotchAgent): number {
  const rank = notchAttentionRank(a);
  const byRank = rank - notchAttentionRank(b);
  if (byRank !== 0) return byRank;
  // A blocked agent loses time while it waits: the longest wait comes first.
  if (rank <= 1) return (a.lastActivityAtMs ?? 0) - (b.lastActivityAtMs ?? 0);
  if (a.status === "done") return (b.lastActivityAtMs ?? 0) - (a.lastActivityAtMs ?? 0);
  return (b.turnStartedAtMs ?? 0) - (a.turnStartedAtMs ?? 0);
}

export function composeNotchSnapshot(input: NotchComposeInput): NotchSnapshot {
  const tracked = new Set(notchTrackedFeatureIds(input));
  const agents = input.digest
    .filter((entry) => tracked.has(entry.feature_id))
    .map((entry) => toAgent(input, entry))
    .sort(compareAgents);
  return { agents };
}
