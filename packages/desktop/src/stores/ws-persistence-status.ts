import { z } from "zod";
import { toast } from "sonner";
import type { StoreAccessors } from "./ws-envelope-types";
import { updateSession } from "./ws-session-types";
import { repairRecoveredPersistence } from "./ws-persistence-resync";

const persistenceStatusSchema = z.object({
  status: z.enum(["degraded", "recovered", "failed"]),
  message: z.string().trim().min(1),
});

export type PersistenceStatus = z.infer<typeof persistenceStatusSchema>;

/** Saving the transcript can fail while the agent continues working. */
export function handlePersistenceStatus(
  ctx: StoreAccessors,
  sessionId: string,
  payload: unknown,
): void {
  const parsed = persistenceStatusSchema.safeParse(payload);
  if (!parsed.success) {
    toast.error("The service sent an invalid transcript saving update.");
    return;
  }
  const previous = ctx.getSession(sessionId).persistenceStatus;
  const next = parsed.data;
  if (previous?.status === next.status && previous.message === next.message) {
    if (next.status === "recovered") repairRecoveredPersistence(ctx, sessionId);
    return;
  }
  ctx.set(updateSession(ctx.get(), sessionId, { persistenceStatus: next }));
  // Initial/replayed healthy state is quiet; announce a confirmed repair only
  // when this viewer actually saw the warning it resolves.
  if (next.status === "recovered" && previous && previous.status !== "recovered") {
    toast.success(next.message, { id: `transcript-persistence:${sessionId}` });
  }
  if (next.status === "recovered") repairRecoveredPersistence(ctx, sessionId);
}
