/**
 * Per-feature streaming buffer for the push dialog's terminal pane.
 *
 * Mirror of `useCommitOutputStore` — kept as a separate slice (rather than
 * a "kind"-namespaced merge) because:
 *
 *  - commit and push lifecycles are independent, sometimes concurrent on
 *    different features, and grouping them under one slice would force
 *    every subscriber to filter on action,
 *  - `git/push.*` envelopes get distinct handlers in `ws-git-status-handler`,
 *    one less moving part to keep in sync.
 *
 * Implementation lives in {@link createGitOutputStore}.
 *
 * The buffer is capped at 100 KB; once exceeded we drop the oldest 25 KB
 * so a runaway log can't grow the React tree without bound.
 */
import { createGitOutputStore } from "./createGitOutputStore";

const bundle = createGitOutputStore();

export const usePushOutputStore = bundle.useStore;

/** Narrow selector: the buffer for a single feature, or `""` when absent. */
export const selectPushOutput = bundle.selectOutput;

/** Narrow selector: whether the push is currently running. */
export const selectPushRunning = bundle.selectRunning;
