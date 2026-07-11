/**
 * Lifecycle tests for the per-feature push streaming buffer.
 *
 * The store mirrors `useCommitOutputStore`, but lives in its own slice so
 * concurrent commit + push (across features) don't trample each other —
 * see the comment block at the top of `usePushOutputStore.ts`.
 *
 * Tests below pin the WS lifecycle contract:
 *   - `start(id)` resets that feature's buffer + flips `running=true`,
 *   - `append(id, chunk)` keeps chunk order and is a no-op for other
 *     features,
 *   - `complete(id)` flips `running=false` and preserves the buffer so
 *     the dialog's terminal pane still shows the final log.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { selectPushOutput, selectPushRunning, usePushOutputStore } from "./usePushOutputStore";

beforeEach(() => {
  // Wipe the store between tests so leaked state from one case can't
  // mask a regression in the next.
  usePushOutputStore.setState({ byFeature: {} });
});

describe("usePushOutputStore lifecycle", () => {
  it("start() resets the buffer for a feature and marks it running", () => {
    const store = usePushOutputStore.getState();
    store.append(1, "stale chunk from a previous run");
    store.start(1);
    const s = usePushOutputStore.getState();
    expect(selectPushOutput(1)(s)).toBe("");
    expect(selectPushRunning(1)(s)).toBe(true);
  });

  it("append() concatenates chunks in order", () => {
    const store = usePushOutputStore.getState();
    store.start(1);
    store.append(1, "Counting objects: 100%\n");
    store.append(1, "remote: ok\n");
    expect(selectPushOutput(1)(usePushOutputStore.getState())).toBe(
      "Counting objects: 100%\nremote: ok\n",
    );
  });

  it("complete() flips running=false but preserves the buffer", () => {
    const store = usePushOutputStore.getState();
    store.start(1);
    store.append(1, "ok\n");
    store.complete(1, true);
    const s = usePushOutputStore.getState();
    expect(selectPushRunning(1)(s)).toBe(false);
    expect(selectPushOutput(1)(s)).toBe("ok\n");
  });

  it("append() to one feature does not affect another feature's buffer", () => {
    const store = usePushOutputStore.getState();
    store.start(1);
    store.start(2);
    store.append(1, "feature-1 chunk");
    store.append(2, "feature-2 chunk");
    store.append(1, "\nfeature-1 again");

    const s = usePushOutputStore.getState();
    expect(selectPushOutput(1)(s)).toBe("feature-1 chunk\nfeature-1 again");
    expect(selectPushOutput(2)(s)).toBe("feature-2 chunk");
  });

  it("complete() on one feature does not flip another feature's running flag", () => {
    const store = usePushOutputStore.getState();
    store.start(1);
    store.start(2);
    store.complete(1, true);
    const s = usePushOutputStore.getState();
    expect(selectPushRunning(1)(s)).toBe(false);
    expect(selectPushRunning(2)(s)).toBe(true);
  });

  it("reset() removes both buffer and running flag for a feature", () => {
    const store = usePushOutputStore.getState();
    store.start(1);
    store.append(1, "data");
    store.reset(1);
    const s = usePushOutputStore.getState();
    // Selectors fall back to "" / false when the feature is absent — the
    // dialog relies on this to render an empty pane after close+reopen.
    expect(selectPushOutput(1)(s)).toBe("");
    expect(selectPushRunning(1)(s)).toBe(false);
  });
});
