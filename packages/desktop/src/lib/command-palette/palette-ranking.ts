import type { ConversationIndexEntry, Project } from "@/api/generated";
import { parseUTCDateTime } from "@/lib/date-utils";
import { DAY_MS } from "@/lib/sidebar-time";
import type { NextActionKind } from "@/lib/next-actions";
import type { AttentionState } from "@/lib/sidebar-attention";
import { frecencyWeight, MAX_FRECENCY_BOOST, type FrecencyMap } from "./palette-frecency";
import type { PaletteScope } from "./palette-query";
import { scoreFields, type PaletteMatch } from "./palette-score";
import type {
  CommandEntry,
  ConversationEntry,
  PaletteCommand,
  PaletteSection,
  ProjectEntry,
} from "./palette-types";

/** Everything ranking reads besides the query, gathered once per keystroke. */
export interface RankContext {
  now: number;
  activeProjectId: number | null;
  activeFeatureId: number | null;
  scope: PaletteScope;
  frecency: FrecencyMap;
  /** Live state of the conversations that have one; the rest are idle. */
  attention: ReadonlyMap<number, AttentionState>;
  projectNames: ReadonlyMap<number, string>;
}

/** Ranked rows, best first, with the best row's score to order sections by. */
export interface Ranked<T> {
  entries: T[];
  top: number;
}

function topRanked<T>(scored: { entry: T; score: number }[], limit: number): Ranked<T> {
  const sorted = scored.sort((a, b) => b.score - a.score).slice(0, limit);
  return { entries: sorted.map(({ entry }) => entry), top: sorted[0]?.score ?? 0 };
}

export const conversationKey = (id: number) => `conv:${id}`;
export const commandKey = (id: string) => `cmd:${id}`;
export const projectKey = (id: number) => `project:${id}`;

export const commandEntry = (
  command: PaletteCommand,
  ranges: CommandEntry["ranges"] = [],
): CommandEntry => ({
  kind: "command",
  key: commandKey(command.id),
  command,
  ranges,
});

function inScope(conversation: ConversationIndexEntry, context: RankContext): boolean {
  if (context.scope === "active") return conversation.status === "active";
  if (context.scope === "project") return conversation.project_id === context.activeProjectId;
  return true;
}

/** Parsed once per index row: ranking and the Recent sort read it many times. */
const activityTimes = new WeakMap<ConversationIndexEntry, number>();

function activityTime(conversation: ConversationIndexEntry): number {
  let time = activityTimes.get(conversation);
  if (time === undefined) {
    const parsed = parseUTCDateTime(conversation.last_activity_at).getTime();
    time = Number.isNaN(parsed) ? 0 : parsed;
    activityTimes.set(conversation, time);
  }
  return time;
}

/** Lifts what the user is likely after: picked before, touched lately, needing them, nearby. */
function conversationBoost(conversation: ConversationIndexEntry, context: RankContext): number {
  const picked = frecencyWeight(context.frecency[conversationKey(conversation.id)], context.now);
  const ageDays = Math.max(0, context.now - activityTime(conversation)) / DAY_MS;
  const state = context.attention.get(conversation.id) ?? "idle";
  let boost = picked * MAX_FRECENCY_BOOST + 0.12 * Math.exp(-ageDays / 7);
  if (conversation.status === "archived") boost -= 0.22;
  if (conversation.project_id === context.activeProjectId) boost += 0.06;
  if (state === "waiting" || state === "failed") boost += 0.08;
  else if (state !== "idle") boost += 0.04;
  if (conversation.id === context.activeFeatureId) boost -= 0.1;
  return boost;
}

function toConversationEntry(
  conversation: ConversationIndexEntry,
  context: RankContext,
  match: PaletteMatch | null,
  nextAction?: NextActionKind,
): ConversationEntry {
  return {
    kind: "conversation",
    key: conversationKey(conversation.id),
    conversation,
    attention: context.attention.get(conversation.id) ?? "idle",
    nextAction,
    ranges: match?.ranges ?? [],
  };
}

/** Conversations matching `tokens`, best first. */
export function rankConversations(
  tokens: readonly string[],
  conversations: readonly ConversationIndexEntry[],
  context: RankContext,
  limit: number,
): Ranked<ConversationEntry> {
  const scored: { entry: ConversationEntry; score: number }[] = [];
  for (const conversation of conversations) {
    if (!inScope(conversation, context)) continue;
    const match = scoreFields(tokens, [
      { text: conversation.title, weight: 1 },
      { text: conversation.label ?? "", weight: 0.7 },
      { text: conversation.worktree_branch ?? "", weight: 0.6 },
      { text: context.projectNames.get(conversation.project_id) ?? "", weight: 0.45 },
      { text: conversation.runtime_provider ?? "", weight: 0.3 },
    ]);
    if (!match) continue;
    scored.push({
      entry: toConversationEntry(conversation, context, match),
      score: match.score + conversationBoost(conversation, context),
    });
  }
  return topRanked(scored, limit);
}

export function rankCommands(
  tokens: readonly string[],
  commands: readonly PaletteCommand[],
  context: RankContext,
  limit: number,
): Ranked<CommandEntry> {
  const scored = commands.flatMap((command) => {
    const match = scoreFields(tokens, [
      { text: command.title, weight: 1 },
      { text: (command.keywords ?? []).join(" "), weight: 0.65 },
      { text: command.group, weight: 0.4 },
    ]);
    if (!match) return [];
    const picked = frecencyWeight(context.frecency[commandKey(command.id)], context.now);
    return [
      {
        entry: commandEntry(command, match.ranges),
        score: match.score + picked * MAX_FRECENCY_BOOST,
      },
    ];
  });
  return topRanked(scored, limit);
}

function projectCounts(conversations: readonly ConversationIndexEntry[]) {
  const counts = new Map<number, { active: number; archived: number }>();
  for (const conversation of conversations) {
    const count = counts.get(conversation.project_id) ?? { active: 0, archived: 0 };
    if (conversation.status === "archived") count.archived += 1;
    else count.active += 1;
    counts.set(conversation.project_id, count);
  }
  return counts;
}

function toProjectEntry(
  project: Project,
  counts: ReadonlyMap<number, { active: number; archived: number }>,
  match: PaletteMatch | null,
): ProjectEntry {
  const count = counts.get(project.id) ?? { active: 0, archived: 0 };
  return {
    kind: "project",
    key: projectKey(project.id),
    project,
    activeCount: count.active,
    archivedCount: count.archived,
    ranges: match?.ranges ?? [],
  };
}

/** Every project as a row, in the given order. */
export function listProjects(
  projects: readonly Project[],
  conversations: readonly ConversationIndexEntry[],
): ProjectEntry[] {
  const counts = projectCounts(conversations);
  return projects.map((project) => toProjectEntry(project, counts, null));
}

export function rankProjects(
  tokens: readonly string[],
  projects: readonly Project[],
  conversations: readonly ConversationIndexEntry[],
  limit: number,
): Ranked<ProjectEntry> {
  if (tokens.length === 0) return { entries: [], top: 0 };
  const counts = projectCounts(conversations);
  const scored = projects.flatMap((project) => {
    const match = scoreFields(tokens, [
      { text: project.name, weight: 1 },
      { text: project.path, weight: 0.5 },
    ]);
    return match ? [{ entry: toProjectEntry(project, counts, match), score: match.score }] : [];
  });
  return topRanked(scored, limit);
}

export interface EmptyStateInput {
  conversations: readonly ConversationIndexEntry[];
  /** The "For me" list, most urgent first. */
  nextActions: readonly { featureId: number; kind: NextActionKind }[];
  suggestions: readonly PaletteCommand[];
}

const NEEDS_YOU_LIMIT = 5;
const IN_PROGRESS_LIMIT = 4;
const RECENT_LIMIT = 7;

/**
 * What the palette shows before anything is typed: what needs the user, agents
 * at work, then the conversations they were last in (the open one left out, so
 * the first Recent row is the one they came from), then a few commands.
 */
export function emptyStateSections(input: EmptyStateInput, context: RankContext): PaletteSection[] {
  const byId = new Map(input.conversations.map((conversation) => [conversation.id, conversation]));
  const shown = new Set<number>([context.activeFeatureId ?? -1]);
  const needsYou: ConversationEntry[] = [];
  for (const { featureId, kind } of input.nextActions) {
    const conversation = byId.get(featureId);
    if (conversation?.status !== "active" || shown.has(featureId)) continue;
    shown.add(featureId);
    needsYou.push(toConversationEntry(conversation, context, null, kind));
    if (needsYou.length === NEEDS_YOU_LIMIT) break;
  }
  const working = input.conversations
    .filter((conversation) => context.attention.get(conversation.id) === "working")
    .filter((conversation) => !shown.has(conversation.id))
    .slice(0, IN_PROGRESS_LIMIT)
    .map((conversation) => {
      shown.add(conversation.id);
      return toConversationEntry(conversation, context, null);
    });
  const recentScore = (conversation: ConversationIndexEntry) =>
    Math.max(
      activityTime(conversation),
      context.frecency[conversationKey(conversation.id)]?.at ?? 0,
    );
  const recent = input.conversations
    .filter((conversation) => !shown.has(conversation.id))
    .filter(
      (conversation) =>
        conversation.status === "active" || context.frecency[conversationKey(conversation.id)],
    )
    .sort((a, b) => recentScore(b) - recentScore(a))
    .slice(0, RECENT_LIMIT)
    .map((conversation) => toConversationEntry(conversation, context, null));
  const suggestions = input.suggestions.map((command) => commandEntry(command));
  return [
    { id: "needs-you", title: "Needs you", entries: needsYou },
    { id: "in-progress", title: "In progress", entries: working },
    { id: "recent", title: "Recent", entries: recent },
    { id: "suggestions", title: "Suggestions", entries: suggestions },
  ].filter((section) => section.entries.length > 0);
}
