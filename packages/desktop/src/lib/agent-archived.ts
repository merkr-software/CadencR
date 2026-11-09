import { toast } from "sonner";
import { z } from "zod";
import { cleanupReportSchema } from "@/lib/archive-cleanup-events";
import { doneSummary, stepsNeedingAttention } from "@/lib/archive-cleanup-report";
import { invalidateByUrlPrefix, queryClient } from "@/lib/queryClient";

/** `app/agent_archived`: an agent archived a conversation with `project_archive_session`. */
const agentArchivedSchema = z.object({
  project_id: z.number(),
  feature_id: z.number(),
  title: z.string(),
  archived_by: z.string(),
  archived_feature_ids: z.array(z.number()),
  cleanup: cleanupReportSchema,
});

/**
 * The toast for an archive an agent made. Leaving and closing the archived
 * conversations happens on `app/archive_cleanup`, as for every archive; steps
 * left for the user are listed by `ArchiveCleanupNotices`.
 */
export function handleAgentArchived(payload: unknown): void {
  const parsed = agentArchivedSchema.safeParse(payload);
  if (!parsed.success) {
    void invalidateByUrlPrefix(queryClient, "/api/features");
    toast.error("An agent archived a session", {
      description: "Cadencr could not read the archive details; the session list was refreshed.",
    });
    return;
  }
  const event = parsed.data;
  const relatives = event.archived_feature_ids.length - 1;
  const title = `${event.archived_by} archived “${event.title}”${
    relatives > 0 ? ` and ${relatives} related ${relatives === 1 ? "session" : "sessions"}` : ""
  }`;
  if (stepsNeedingAttention(event.cleanup).length > 0) {
    toast.warning(`${title}, but cleanup is incomplete`, {
      description: "Review it to resume or force the remaining steps.",
    });
    return;
  }
  toast.success(title, { description: doneSummary(event.cleanup) });
}
