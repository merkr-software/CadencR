import type { QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  getListSchedulesQueryKey,
  updateFeatureStatus,
  type CleanupReport,
  type Schedule,
} from "@/api/generated";
import { apiErrorMessage } from "@/lib/api-errors";
import { invalidateFeatureLists } from "@/lib/featureUpdated";
import { getCoarsePointerSnapshot, getPhoneShellSnapshot } from "@/lib/form-factor";
import { RESET_TOAST_STAGE } from "@/lib/staged-toast";

/** An archive toast that offers Undo stays this long (as the sidebar preset's Undo). */
export const ARCHIVE_UNDO_TOAST_MS = 10_000;

/**
 * The archive Undo is for the phone layout under a finger, where a swipe
 * archives (`SidebarRowSwipeTray`). A narrow desktop window keeps the hover
 * actions and the plain toast.
 */
export function offersArchiveUndo(): boolean {
  return getPhoneShellSnapshot() && getCoarsePointerSnapshot();
}

/**
 * Undo only flips the status back: it cannot bring back a worktree or a branch.
 * So it is offered only when neither was asked for, or the step had nothing
 * to remove (skipped).
 */
export function canUndoArchive(report: CleanupReport): boolean {
  return [report.worktree, report.branch].every((step) => !step || step.status === "skipped");
}

/**
 * One id per enabled schedule bound to a conversation, read from the full
 * schedule list (the sidebar's Schedules link keeps it cached) before the
 * archive pauses them. `null`: that list isn't cached, so nothing is known; a
 * per-conversation or per-project list would miss the other conversations.
 */
export function enabledScheduleFeatureIds(client: QueryClient): number[] | null {
  const list = client.getQueryData<Schedule[]>(
    getListSchedulesQueryKey({ feature_id: undefined, project_id: undefined }),
  );
  if (!Array.isArray(list)) return null;
  return list.flatMap((schedule) =>
    schedule.enabled && schedule.target.feature_id != null ? [schedule.target.feature_id] : [],
  );
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/**
 * What Undo leaves as the archive made it, said on the "restored" toast:
 * closed terminals and browser tabs, paused schedules (the service pauses
 * every enabled schedule of an archived conversation; `scheduleFeatureIds`
 * from `enabledScheduleFeatureIds`, read before the archive).
 */
export function archiveUndoCaveats(
  report: CleanupReport,
  archivedIds: readonly number[],
  scheduleFeatureIds: readonly number[] | null,
): string | undefined {
  const closed = [
    report.terminals?.status === "done" ? "terminals" : null,
    report.browser_tabs?.status === "done" ? "browser tabs" : null,
  ].filter((name): name is string => name !== null);
  const notes: string[] = [];
  if (closed.length > 0) notes.push(`Its ${closed.join(" and ")} stay closed.`);
  if (scheduleFeatureIds === null) {
    notes.push("Any schedule the archive paused stays paused.");
  } else {
    const archived = new Set(archivedIds);
    const paused = scheduleFeatureIds.filter((featureId) => archived.has(featureId)).length;
    if (paused > 0) {
      notes.push(`${plural(paused, "schedule")} ${paused === 1 ? "stays" : "stay"} paused.`);
    }
  }
  return notes.length > 0 ? notes.join(" ") : undefined;
}

export interface ArchiveUndo {
  /** The conversation the archive was asked for: keys the Undo toast. */
  featureId: number;
  /** Everything the archive took, relatives included. */
  archivedIds: readonly number[];
  projectId: number | null;
  /** What stays as the archive left it (`archiveUndoCaveats`). */
  caveats: string | undefined;
}

/**
 * The archive toast's Undo: unarchives every conversation the archive took
 * through the same status write as the context menu's Unarchive. Nothing
 * changes on screen before the service answers: a loading toast holds the
 * wait, the lists refetch once every write settled, and the toast then says
 * what was restored (and what Undo left as it was), or names the error.
 */
export async function undoArchive(
  client: QueryClient,
  { featureId, archivedIds, projectId, caveats }: ArchiveUndo,
): Promise<void> {
  const id = `archive-undo-${featureId}`;
  toast.loading("Restoring session…", { ...RESET_TOAST_STAGE, id });
  const results = await Promise.allSettled(
    archivedIds.map((archivedId) => updateFeatureStatus(archivedId, { status: "active" })),
  );
  await invalidateFeatureLists(client, projectId);
  const failure = results.find((result) => result.status === "rejected");
  const restored = results.length - results.filter((result) => result.status === "rejected").length;
  if (!failure) {
    const title = restored === 1 ? "Session restored" : `${plural(restored, "session")} restored`;
    toast.success(title, { ...RESET_TOAST_STAGE, id, description: caveats });
    return;
  }
  const reason = apiErrorMessage(failure.reason, "Unarchive failed");
  toast.error(
    restored === 0
      ? "Could not restore session"
      : `${restored} of ${plural(results.length, "session")} restored`,
    { ...RESET_TOAST_STAGE, id, description: reason },
  );
}
