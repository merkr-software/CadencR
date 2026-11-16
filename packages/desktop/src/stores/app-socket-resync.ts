/**
 * Caches the app socket keeps fresh by push are only as current as the last
 * event received. Every event emitted while the socket was down is lost, so a
 * reconnect refetches each push-maintained family instead of trusting what
 * the cache last heard.
 */
import { getAlacrittyConfigRouteQueryKey } from "@/api/generated";
import { createLeadingSettleCoalescer } from "@/lib/coalesceInvalidation";
import { queryClient, urlPrefixPredicate } from "@/lib/queryClient";
import { invalidatePromptQueue } from "@/lib/prompt-queue";
import { refreshPluginTabReads } from "@/lib/plugin-tabs/live-instances";
import { invalidateScheduleLists } from "@/lib/schedules/invalidate";
import { scheduleSettingsInvalidation } from "@/lib/settingsInvalidation";
import { scheduleThemeInvalidation } from "@/lib/themeInvalidation";
import { scheduleEditorInvalidation } from "@/stores/session-status-handlers";

/** URL families `feature_event`, `theme_event`, and `custom_action_event` keep current. */
const isPushedFamily = urlPrefixPredicate([
  "/api/features",
  "/api/projects",
  "/api/custom-actions",
]);

/** A conversation transcript resyncs over its own socket (`ws-session-resync`). */
function isTranscript(url: string): boolean {
  return /^\/api\/features\/[^/]+\/agent-state(?:[/?]|$)/.test(url);
}

/**
 * A flapping connection reconnects every few seconds; each reconnect must not
 * refetch every list again, so a burst folds into one leading and one trailing
 * wave.
 */
const RESYNC_SETTLE_MS = 5_000;

function resync(): Promise<void> {
  invalidateScheduleLists(queryClient);
  scheduleThemeInvalidation(queryClient);
  scheduleEditorInvalidation();
  scheduleSettingsInvalidation(queryClient);
  invalidatePromptQueue(undefined);
  return Promise.all([
    queryClient.invalidateQueries({
      predicate: (query) => isPushedFamily(query) && !isTranscript(String(query.queryKey[0])),
    }),
    refreshPluginTabReads(),
    queryClient.invalidateQueries({ queryKey: getAlacrittyConfigRouteQueryKey() }),
  ]).then(() => undefined);
}

const coalescer = createLeadingSettleCoalescer(resync, RESYNC_SETTLE_MS);

/** Coalesced: call on every reconnect. */
export function resyncPushMaintainedQueries(): void {
  coalescer.trigger();
}

/** Test-only: drop the open settle window. */
export function resetPushResyncForTests(): void {
  coalescer.reset();
}
