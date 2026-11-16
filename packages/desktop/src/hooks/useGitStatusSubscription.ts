import { useEffect } from "react";
import { useSessionStatusStore } from "@/stores/session-status-store";
import { selectGitWatcherEpoch, useGitStatusStore } from "@/stores/useGitStatusStore";

/**
 * Subscribes the active app-level WebSocket to per-feature `git.status`
 * envelopes. Mirrors `useFileWatcher`: one connection serves the whole app,
 * we just send `app/subscribe.git_status` / `unsubscribe.git_status`
 * envelopes carrying the feature_id. The backend's `GitWatcherRegistry`
 * starts a `notify` watcher on first subscription and tears it down after
 * the last unsubscribe.
 *
 * The first event the backend pushes after subscribing is the initial
 * snapshot, which `ws-git-status-handler` writes into `useGitStatusStore`.
 *
 * **Re-subscribes on worktree transitions.** The backend resolves the
 * watcher's path *at subscribe time* (`worktree_path` setting → project path
 * fallback). If we mount before the worktree exists, the initial subscription
 * binds to the project path — and keeps emitting snapshots from there even
 * after `worktree_path` is written. The WS envelope handler bumps a per-
 * feature `watcherEpoch` whenever it sees `workflow/worktree.created` or
 * `workflow/worktree.ready`; including the epoch in the effect deps tears
 * down the old subscription and starts a new one, forcing the backend to
 * re-resolve and bind to the freshly-created worktree. The epoch is driven
 * by the WS envelope (single source of truth) rather than by local
 * worktreeStatus fields.
 */
export function useGitStatusSubscription(featureId: number | null | undefined): void {
  const isConnected = useSessionStatusStore((s) => s.isConnected);
  const connectionEpoch = useSessionStatusStore((s) => s.connectionEpoch);
  const subscribeGitStatus = useSessionStatusStore((s) => s.subscribeGitStatus);
  const watcherEpoch = useGitStatusStore(selectGitWatcherEpoch(featureId));

  useEffect(() => {
    if (featureId == null || !isConnected) return;
    return subscribeGitStatus(featureId);
    // `watcherEpoch` is in the deps on purpose — see the docblock above.
  }, [isConnected, connectionEpoch, subscribeGitStatus, featureId, watcherEpoch]);
}
