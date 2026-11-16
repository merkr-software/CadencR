import { getListSessionPromptQueueQueryKey } from "@/api/generated";
import { queryClient } from "@/lib/queryClient";

/** Re-fetch one session's queued prompts, or every session's when unknown. */
export function invalidatePromptQueue(sessionId: number | undefined): void {
  if (sessionId !== undefined) {
    void queryClient.invalidateQueries({ queryKey: getListSessionPromptQueueQueryKey(sessionId) });
    return;
  }
  void queryClient.invalidateQueries({
    predicate: (query) =>
      typeof query.queryKey[0] === "string" && query.queryKey[0].endsWith("/prompt-queue"),
  });
}
