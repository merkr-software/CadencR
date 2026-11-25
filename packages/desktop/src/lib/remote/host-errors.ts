import { isAxiosError } from "axios";
import { z } from "zod";

const hostErrorBody = z.object({
  details: z.discriminatedUnion("code", [
    z.object({ code: z.literal("REMOTE_RENDERER_DIRECTORY_MISSING") }),
    z.object({ code: z.literal("REMOTE_RENDERER_INDEX_MISSING"), path: z.string() }),
    z.object({ code: z.literal("REMOTE_PAIRING_DISABLED") }),
  ]),
});

export function readRemoteHostErrorDetails(error: unknown) {
  if (!isAxiosError(error)) return undefined;
  const parsed = hostErrorBody.safeParse(error.response?.data);
  return parsed.success ? parsed.data.details : undefined;
}
