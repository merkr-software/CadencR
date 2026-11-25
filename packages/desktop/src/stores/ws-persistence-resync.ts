import { translateUi } from "@/lib/i18n/ui";
import { capturePersistenceRepair } from "./ws-persistence-repair-plan";
import type { StoreAccessors } from "./ws-envelope-types";
import { resyncRecoveredPersistence } from "./ws-session-resync";
import { toast } from "sonner";

const repairs = new Map<string, Promise<void>>();
const retriggered = new Set<string>();

export function repairRecoveredPersistence(ctx: StoreAccessors, sessionId: string): void {
  if (repairs.has(sessionId)) {
    retriggered.add(sessionId);
    return;
  }
  const pending = resyncRecoveredPersistence(ctx, sessionId)
    .catch(() => {
      toast.error(
        translateUi(
          "conversation.history.couldNotRefresh",
          "Conversation history was saved, but its display could not be refreshed. Reconnect to retry.",
        ),
      );
    })
    .finally(() => {
      repairs.delete(sessionId);
      const session = ctx.get().sessions[sessionId];
      if (retriggered.delete(sessionId) && session && capturePersistenceRepair(session)) {
        repairRecoveredPersistence(ctx, sessionId);
      }
    });
  repairs.set(sessionId, pending);
}
