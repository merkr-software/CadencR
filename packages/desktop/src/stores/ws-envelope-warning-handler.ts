import type { SessionWarningPayload } from "@/api/generated";
import { toast } from "sonner";
import { z } from "zod";
import type { StoreAccessors } from "./ws-envelope-types";

const warningSchema = z.object({
  code: z.string().trim().min(1),
  message: z.string().trim().min(1),
}) satisfies z.ZodType<SessionWarningPayload>;

/** An accepted command can report a warning while its agent keeps working. */
export function handleWarning(_ctx: StoreAccessors, sessionId: string, payload: unknown): void {
  const parsed = warningSchema.safeParse(payload);
  if (!parsed.success) {
    toast.error("The service sent an invalid session warning. The conversation was not changed.");
    return;
  }
  // Keep these command notices outside the stream: even appending an inline
  // error rebuilds stream indexes and can misrepresent an accepted action.
  toast.warning(parsed.data.message, { id: `session-warning:${sessionId}:${parsed.data.code}` });
}
