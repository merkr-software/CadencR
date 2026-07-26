import type { QueryClient } from "@tanstack/react-query";
import { getListSchedulesQueryKey } from "@/api/generated";
import { createLeadingSettleCoalescer } from "@/lib/coalesceInvalidation";

/**
 * The one way schedule lists get refreshed.
 *
 * Every variant (all schedules, per-conversation, per-project) shows the same
 * rows, so a change to one has to refresh them all; the param-less key is the
 * shared prefix react-query matches them by.
 *
 * Coalesced, like the settings and editor cues it sits beside in
 * `session-status-handlers.ts`, because two callers can land together: one
 * scheduler tick fires up to `MAX_RUNS_PER_TICK` schedules, each broadcasting
 * its own run, and a "Run now" click arrives twice — once from the mutation
 * that issued it, once from the server's broadcast echoing back. Un-coalesced
 * those cancel each other's in-flight refetch and reissue it. The leading edge
 * keeps a lone change instant.
 */
const SETTLE_MS = 400;

const coalescer = createLeadingSettleCoalescer<QueryClient>((client) => {
  void client.invalidateQueries({ queryKey: getListSchedulesQueryKey() });
}, SETTLE_MS);

export function invalidateScheduleLists(client: QueryClient): void {
  coalescer.trigger(client);
}

/** Test-only: drop the open settle window so cases don't inherit each other's. */
export function resetScheduleInvalidationForTest(): void {
  coalescer.reset();
}
