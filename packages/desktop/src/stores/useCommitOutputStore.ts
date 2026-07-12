/**
 * Per-feature streaming buffer for the commit dialog's terminal pane.
 *
 * The backend's `git/commit.start` resets the buffer; each
 * `git/commit.output` envelope appends one *chunk* (raw PTY read — may
 * be a partial line, multiple lines, or carriage-return progress
 * sequences); `git/commit.complete` marks the run as finished.
 *
 * Each feature has one atomic entry containing its output and lifecycle
 * status, so impossible running/failed combinations cannot be represented.
 * The implementation is shared with `usePushOutputStore`.
 */
import { createGitOutputStore } from "./createGitOutputStore";

const bundle = createGitOutputStore();

export const useCommitOutputStore = bundle.useStore;

/** Narrow selector: the buffer for a single feature, or `""` when absent. */
export const selectCommitOutput = bundle.selectOutput;

/** Narrow selector: current lifecycle status for one feature. */
export const selectCommitStatus = bundle.selectStatus;

/** Narrow selector: whether the commit is currently running. */
export const selectCommitRunning = bundle.selectRunning;

/** Narrow selector: result of the latest completed commit. */
export const selectCommitOutcome = bundle.selectOutcome;
