import { translateUi } from "@/lib/i18n/ui";
import { autoNameWarningMessage } from "@/lib/auto-name-errors";
import type { SessionWarningPayload } from "@/api/generated";
import { toast } from "sonner";
import { z } from "zod";
import type { StoreAccessors } from "./ws-envelope-types";

const warningSchema = z.object({
  code: z.string().trim().min(1),
  message: z.string().trim().min(1),
  auto_name_reason: z.string().nullish(),
}) satisfies z.ZodType<SessionWarningPayload>;

/** An accepted command can report a warning while its agent keeps working. */
export function handleWarning(_ctx: StoreAccessors, sessionId: string, payload: unknown): void {
  const parsed = warningSchema.safeParse(payload);
  if (!parsed.success) {
    toast.error(
      translateUi(
        "conversation.stream.invalidWarning",
        "The service sent an invalid session warning. The conversation was not changed.",
      ),
    );
    return;
  }
  // Keep these command notices outside the stream: even appending an inline
  // error rebuilds stream indexes and can misrepresent an accepted action.
  const { code, message, auto_name_reason } = parsed.data;
  toast.warning(autoNameWarningMessage(code, message, auto_name_reason ?? undefined), {
    id: `session-warning:${sessionId}:${code}`,
  });
}
