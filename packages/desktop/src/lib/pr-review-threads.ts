/**
 * Pure helpers over the forge's review threads.
 *
 * "Unresolved" is deliberately `resolved !== true` rather than
 * `resolved === false`: a plain PR comment has no resolution state at all
 * (`null`), and hiding those would quietly drop review feedback that still
 * needs an answer. Only a thread the forge explicitly marked resolved is
 * treated as done.
 */
import type { CommentThread, PrSummary, ThreadSide } from "@/api/generated";
import { keepGitPath, type AgentPathMapper } from "@/lib/git-paths";

/** Review threads anchored to one line of one file, keyed by diff side. */
export interface PrThreadLine {
  lineNumber: number;
  side: ThreadSide;
  threads: CommentThread[];
}

export interface ReviewNavigationTarget {
  threadId: string;
  filePath: string;
  lineNumber: number;
  side: ThreadSide;
}

export interface ReviewThreadSummary {
  total: number;
  anchored: number;
  general: number;
  outdated: number;
  automated: number;
  byFile: Map<string, number>;
}

export function isThreadUnresolved(thread: CommentThread): boolean {
  return thread.resolved !== true;
}

export function isThreadAnchored(thread: CommentThread): boolean {
  return !thread.outdated && !!thread.file && thread.line != null;
}

export function isAutomatedReviewThread(thread: CommentThread): boolean {
  return thread.comments.some((comment) => {
    const username = comment.author.username.trim().toLowerCase();
    const name = comment.author.display_name?.trim().toLowerCase() ?? "";
    return (
      username.endsWith("[bot]") ||
      username.endsWith("-bot") ||
      username.endsWith("_bot") ||
      name === "bot" ||
      name.endsWith(" bot")
    );
  });
}

function firstCommentTime(thread: CommentThread): number {
  const value = Date.parse(thread.comments[0]?.created_at ?? "");
  return Number.isFinite(value) ? value : 0;
}

function reviewThreadRank(thread: CommentThread): number {
  if (!isThreadUnresolved(thread)) return 10;
  const automated = isAutomatedReviewThread(thread) ? 1 : 0;
  if (isThreadAnchored(thread)) return automated;
  if (!thread.outdated) return 2 + automated;
  return 4 + automated;
}

/**
 * The unresolved view is a work queue, not a transcript. Current human-authored
 * line feedback comes first, followed by automation, general discussion, and
 * finally outdated history. Stable file/line ordering makes repeat visits
 * predictable while the timestamp breaks ties within one location.
 */
export function sortReviewThreadsForAction(threads: readonly CommentThread[]): CommentThread[] {
  return threads
    .map((thread) => ({
      thread,
      rank: reviewThreadRank(thread),
      file: thread.file ?? "",
      line: thread.line ?? Number.MAX_SAFE_INTEGER,
      time: firstCommentTime(thread),
    }))
    .sort((left, right) => {
      const byRank = left.rank - right.rank;
      if (byRank !== 0) return byRank;
      const byFile = left.file.localeCompare(right.file);
      if (byFile !== 0) return byFile;
      const byLine = left.line - right.line;
      if (byLine !== 0) return byLine;
      return right.time - left.time;
    })
    .map(({ thread }) => thread);
}

export function unresolvedThreads(threads: readonly CommentThread[]): CommentThread[] {
  return sortReviewThreadsForAction(threads.filter(isThreadUnresolved));
}

export function summarizeReviewThreads(threads: readonly CommentThread[]): ReviewThreadSummary {
  const byFile = new Map<string, number>();
  let anchored = 0;
  let general = 0;
  let outdated = 0;
  let automated = 0;
  for (const thread of threads) {
    if (thread.outdated) outdated += 1;
    if (isAutomatedReviewThread(thread)) automated += 1;
    if (isThreadAnchored(thread)) {
      anchored += 1;
      const file = thread.file!;
      byFile.set(file, (byFile.get(file) ?? 0) + 1);
    } else if (!thread.outdated) {
      general += 1;
    }
  }
  return { total: threads.length, anchored, general, outdated, automated, byFile };
}

export function reviewNavigationTargets(
  threads: readonly CommentThread[],
): ReviewNavigationTarget[] {
  return threads.flatMap((thread) => {
    if (!isThreadAnchored(thread)) return [];
    return [
      {
        threadId: thread.id,
        filePath: thread.file!,
        lineNumber: thread.line!,
        side: thread.side ?? "new",
      },
    ];
  });
}

export function threadExternalHost(thread: CommentThread): string | null {
  const href = thread.comments.find((comment) => comment.url)?.url;
  if (!href) return null;
  try {
    return new URL(href).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

/**
 * Groups unresolved, line-anchored threads by file so the diff can hand each
 * `DiffFileBlock` only the threads that belong to it. Threads without a file or
 * line (top-level PR discussion) have nowhere to land in a diff and are left to
 * the PR tab.
 *
 * Outdated threads are excluded even though they are unresolved. The forge
 * reports no current line for one — the number we hold is `originalLine`, an
 * offset into a revision that has since been rewritten — so drawing it on
 * today's diff would attach a reviewer's words to whatever code now happens to
 * sit at that offset. The PR tab still lists them, flagged `outdated`, and they
 * still reach the agent briefing where the file/line reads as a hint rather
 * than a pointer.
 */
export function unresolvedThreadLinesByFile(
  threads: readonly CommentThread[],
): Map<string, PrThreadLine[]> {
  const byFile = new Map<string, PrThreadLine[]>();
  for (const thread of threads) {
    if (!isThreadUnresolved(thread) || thread.outdated) continue;
    const { file, line } = thread;
    if (!file || line == null) continue;
    // A forge that omits the side always means the post-image; that is the row
    // it renders the thread on too.
    const side: ThreadSide = thread.side ?? "new";
    const lines = byFile.get(file) ?? [];
    const existing = lines.find((entry) => entry.lineNumber === line && entry.side === side);
    if (existing) existing.threads.push(thread);
    else lines.push({ lineNumber: line, side, threads: [thread] });
    byFile.set(file, lines);
  }
  return byFile;
}

/** Indents wrapped lines so a multi-paragraph comment stays inside its bullet. */
function asBullet(label: string, body: string): string {
  const lines = body.trim().split("\n");
  const [first = "", ...rest] = lines;
  return [`- **${label}:** ${first}`, ...rest.map((line) => `  ${line}`)].join("\n");
}

/**
 * Where a thread points, as `file:line`, or `null` when it hangs off the
 * proposal itself rather than a hunk.
 *
 * Shared so the PR pane, the diff annotation, and the agent briefing all name
 * the same thread the same way — they drifted into three spellings once. The
 * forge's path is repository-relative; the briefing passes `toAgentPath` to
 * name the file from the agent's working directory instead.
 */
export function threadLocation(
  thread: CommentThread,
  toAgentPath: AgentPathMapper = keepGitPath,
): string | null {
  if (!thread.file) return null;
  const file = toAgentPath(thread.file);
  return thread.line != null ? `${file}:${thread.line}` : file;
}

function threadHeading(thread: CommentThread, toAgentPath: AgentPathMapper): string {
  const location = threadLocation(thread, toAgentPath);
  if (!location) return "### General discussion";
  const sideNote = thread.side === "old" ? " (on the removed side)" : "";
  const outdatedNote = thread.outdated ? " — outdated, the diff moved since" : "";
  return `### ${location}${sideNote}${outdatedNote}`;
}

/**
 * Renders unresolved threads as a briefing an agent can act on. Attribution is
 * part of the payload on purpose: "the reviewer asked for X" reads differently
 * to an agent than "someone asked for X", and it lets the developer trace a
 * requested change back to whoever wanted it.
 *
 * The forge names files relative to the repository root; `toAgentPath` names
 * them the way the agent resolves them from its working directory.
 */
export function formatPrThreadsForAgent(
  threads: readonly CommentThread[],
  pr: PrSummary | null | undefined,
  toAgentPath: AgentPathMapper,
): string {
  const open = unresolvedThreads(threads);
  if (open.length === 0) return "";
  const subject = pr ? `${pr.pr_label} #${pr.number} — ${pr.title}` : "the open pull request";
  const parts: string[] = [
    `Open review feedback on ${subject}. Please address each selected thread in the code.`,
  ];
  for (const thread of open) {
    parts.push("");
    parts.push(threadHeading(thread, toAgentPath));
    const link = thread.comments[0]?.url;
    if (link) parts.push(`<${link}>`);
    for (const comment of thread.comments) {
      const author = comment.author.display_name ?? comment.author.username;
      parts.push(asBullet(author, comment.body_markdown));
    }
  }
  return parts.join("\n");
}
