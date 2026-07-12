/**
 * Lifecycle tests for the per-feature commit streaming buffer.
 *
 * Mirrors `usePushOutputStore.test.ts` — same shape because the WS lifecycle
 * (`commit.start` / `commit.output` / `commit.complete`) is the same shape
 * as `push.*`. Kept as separate tests rather than a parameterized helper
 * because the test files are tiny and the failure messages are clearer
 * when each store has its own dedicated suite.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  selectCommitOutput,
  selectCommitOutcome,
  selectCommitRunning,
  useCommitOutputStore,
} from "./useCommitOutputStore";

beforeEach(() => {
  useCommitOutputStore.setState({ byFeature: {} });
});

describe("useCommitOutputStore lifecycle", () => {
  it("start() resets the buffer for a feature and marks it running", () => {
    const store = useCommitOutputStore.getState();
    store.append(1, "stale chunk from a previous run");
    store.start(1);
    const s = useCommitOutputStore.getState();
    expect(selectCommitOutput(1)(s)).toBe("");
    expect(selectCommitRunning(1)(s)).toBe(true);
  });

  it("append() concatenates chunks in order", () => {
    const store = useCommitOutputStore.getState();
    store.start(1);
    store.append(1, "[main abc1234] feat: x\n");
    store.append(1, " 1 file changed\n");
    expect(selectCommitOutput(1)(useCommitOutputStore.getState())).toBe(
      "[main abc1234] feat: x\n 1 file changed\n",
    );
  });

  it("ignores orphan output and completion events", () => {
    const store = useCommitOutputStore.getState();
    store.append(1, "late output");
    store.complete(1, false);

    expect(useCommitOutputStore.getState().byFeature[1]).toBeUndefined();
  });

  it("does not reset a running buffer on a duplicate start event", () => {
    const store = useCommitOutputStore.getState();
    store.start(1);
    store.append(1, "already streamed\n");
    store.start(1);

    expect(selectCommitOutput(1)(useCommitOutputStore.getState())).toBe("already streamed\n");
  });

  it("complete() flips running=false but preserves the buffer", () => {
    const store = useCommitOutputStore.getState();
    store.start(1);
    store.append(1, "ok\n");
    store.complete(1, true);
    const s = useCommitOutputStore.getState();
    expect(selectCommitRunning(1)(s)).toBe(false);
    expect(selectCommitOutput(1)(s)).toBe("ok\n");
    expect(selectCommitOutcome(1)(s)).toBe("success");
  });

  it("records a failed outcome until the next run starts", () => {
    const store = useCommitOutputStore.getState();
    store.start(1);
    store.complete(1, false);
    expect(selectCommitOutcome(1)(useCommitOutputStore.getState())).toBe("error");

    store.start(1);
    expect(selectCommitOutcome(1)(useCommitOutputStore.getState())).toBeNull();
  });

  it("records a failure detail and terminal state atomically", () => {
    const store = useCommitOutputStore.getState();
    store.start(1);
    store.append(1, "hook output\n");
    store.fail(1, "lint failed");

    const state = useCommitOutputStore.getState();
    expect(selectCommitOutcome(1)(state)).toBe("error");
    expect(selectCommitOutput(1)(state)).toBe("hook output\n\nlint failed\n");
  });

  it("append() to one feature does not affect another feature's buffer", () => {
    const store = useCommitOutputStore.getState();
    store.start(1);
    store.start(2);
    store.append(1, "feature-1 chunk");
    store.append(2, "feature-2 chunk");
    store.append(1, "\nfeature-1 again");

    const s = useCommitOutputStore.getState();
    expect(selectCommitOutput(1)(s)).toBe("feature-1 chunk\nfeature-1 again");
    expect(selectCommitOutput(2)(s)).toBe("feature-2 chunk");
  });

  it("complete() on one feature does not flip another feature's running flag", () => {
    const store = useCommitOutputStore.getState();
    store.start(1);
    store.start(2);
    store.complete(1, true);
    const s = useCommitOutputStore.getState();
    expect(selectCommitRunning(1)(s)).toBe(false);
    expect(selectCommitRunning(2)(s)).toBe(true);
  });

  it("reset() removes both buffer and running flag for a feature", () => {
    const store = useCommitOutputStore.getState();
    store.start(1);
    store.append(1, "data");
    store.reset(1);
    const s = useCommitOutputStore.getState();
    expect(selectCommitOutput(1)(s)).toBe("");
    expect(selectCommitRunning(1)(s)).toBe(false);
    expect(selectCommitOutcome(1)(s)).toBeNull();
  });
});
