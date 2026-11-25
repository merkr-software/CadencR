import { translateUi } from "@/lib/i18n/ui";
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
    toast.error(
      translateUi(
        "conversation.agentArchived.anAgentArchivedASession",
        "An agent archived a session",
      ),
      {
        description: translateUi(
          "conversation.agentArchived.cadencrCouldNotReadTheArchiveDetailsTheSessionListWasRefreshed",
          "Cadencr could not read the archive details; the session list was refreshed.",
        ),
      },
    );
    return;
  }
  const event = parsed.data;
  const relatives = event.archived_feature_ids.length - 1;
  const data = { agent: event.archived_by, title: event.title };
  const title =
    relatives > 0
      ? translateUi("conversation.agent-archived.archivedWithRelatives", {
          count: relatives,
          ...data,
          defaultValue_one: "{{agent}} archived “{{title}}” and {{count}} related session",
          defaultValue_other: "{{agent}} archived “{{title}}” and {{count}} related sessions",
        })
      : translateUi("conversation.agentArchived.archived", "{{agent}} archived “{{title}}”", data);
  if (stepsNeedingAttention(event.cleanup).length > 0) {
    toast.warning(
      translateUi(
        "conversation.agent-archived.archiveCleanupIncomplete",
        "{{title}}, but cleanup is incomplete",
        { title },
      ),
      {
        description: translateUi(
          "conversation.agentArchived.reviewItToResumeOrForceTheRemainingSteps",
          "Review it to resume or force the remaining steps.",
        ),
      },
    );
    return;
  }
  toast.success(title, { description: doneSummary(event.cleanup) });
}
