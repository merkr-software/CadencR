import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, renderHook } from "@/test-utils";
import { getListProjectsQueryKey, type Project } from "@/api/generated";
import { queryClient } from "@/lib/queryClient";
import { useSessionStatusStore, type SessionStatusEntry } from "@/stores/session-status-store";
import {
  IDLE_SNAPSHOT_REFRESH_MS,
  PRESS_SNAPSHOT_REFRESH_MS,
  SWEEP_MAX_ROWS,
  useConversationPreloadIntent,
} from "./useConversationPreloadIntent";

const mocks = vi.hoisted(() => ({ calls: [] as string[], preload: vi.fn(), prewarm: vi.fn() }));

vi.mock("@/lib/conversation-preload", () => ({
  preloadConversation: (featureId: number, refreshAfterMs: number) => {
    mocks.calls.push(`preload:${featureId}`);
    return Promise.resolve(mocks.preload(featureId, refreshAfterMs));
  },
}));
vi.mock("@/components/workspace-pool/workspace-prewarm", () => ({
  requestWorkspacePrewarm: (target: { featureId: number }) => {
    mocks.calls.push(`prewarm:${target.featureId}`);
    mocks.prewarm(target);
  },
}));

const PROJECT = { id: 3, path: "/repo", name: "repo" } as Project;

const IN_VIEW = { top: 10, bottom: 40, left: 0, right: 240, width: 240, height: 30 };
const BELOW_VIEW = { top: 4_000, bottom: 4_030, left: 0, right: 240, width: 240, height: 30 };

/** A sidebar conversation row, as `ProjectFeatureRow` renders it. */
function addRow(featureId: number, box = IN_VIEW, parent: HTMLElement = document.body) {
  const row = document.createElement("div");
  row.setAttribute("data-nav-type", "feature");
  row.setAttribute("data-nav-id", String(featureId));
  row.setAttribute("data-nav-project-id", String(PROJECT.id));
  row.getBoundingClientRect = () => ({ ...box, x: box.left, y: box.top, toJSON: () => box });
  parent.appendChild(row);
  return row;
}

function press(target: Element, init: Partial<PointerEventInit> = {}): void {
  fireEvent.pointerDown(target, { pointerType: "mouse", button: 0, ...init });
}

function setRunning(featureIds: number[]): void {
  const bySession: Record<number, SessionStatusEntry> = {};
  for (const featureId of featureIds) {
    bySession[featureId] = { status: "agent", kind: null, featureId, seq: 1 } as SessionStatusEntry;
  }
  useSessionStatusStore.setState({ bySession });
}

const preloadedIds = (): number[] => mocks.preload.mock.calls.map(([featureId]) => featureId);

beforeEach(() => {
  mocks.calls.length = 0;
  mocks.preload.mockClear();
  mocks.prewarm.mockClear();
  queryClient.setQueryData(getListProjectsQueryKey(), [PROJECT]);
  useSessionStatusStore.setState({ bySession: {} });
});

afterEach(() => {
  // Unmount while the idle callbacks it cancels are still stubbed.
  cleanup();
  document.body.replaceChildren();
  queryClient.clear();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("a press on a conversation row", () => {
  it("mounts its workspace, then refreshes its snapshot", () => {
    renderHook(() => useConversationPreloadIntent());
    press(addRow(7));

    expect(mocks.calls).toEqual(["prewarm:7", "preload:7"]);
    expect(mocks.prewarm).toHaveBeenCalledWith(
      expect.objectContaining({ featureId: 7, projectId: 3, cwd: "/repo", focusTab: undefined }),
    );
    expect(mocks.preload).toHaveBeenCalledWith(7, PRESS_SNAPSHOT_REFRESH_MS);
  });

  it("does nothing for a secondary button, a modifier or a control inside the row", () => {
    renderHook(() => useConversationPreloadIntent());
    const row = addRow(7);
    const pin = row.appendChild(document.createElement("button"));

    press(row, { button: 2 });
    press(row, { metaKey: true });
    press(row, { shiftKey: true });
    press(pin);

    expect(mocks.calls).toEqual([]);
  });

  it("only preloads for a touch or a pen: a scroll starts on a row too", () => {
    renderHook(() => useConversationPreloadIntent());
    const row = addRow(7);

    press(row, { pointerType: "touch" });
    press(row, { pointerType: "pen" });

    expect(mocks.prewarm).not.toHaveBeenCalled();
    expect(mocks.calls).toEqual(["preload:7", "preload:7"]);
  });
});

describe("the idle sweep", () => {
  /** Idle callbacks the test runs by hand, one idle period each. */
  let idle: Array<() => void> = [];

  async function runIdle(count = Number.POSITIVE_INFINITY): Promise<void> {
    for (let ran = 0; ran < count && idle.length > 0; ran += 1) {
      idle.shift()?.();
      // Flush the step's preload microtasks so the next idle slice is scheduled.
      await vi.advanceTimersByTimeAsync(0);
    }
  }

  beforeEach(() => {
    vi.useFakeTimers();
    idle = [];
    let handle = 0;
    const handles = new Map<number, () => void>();
    vi.stubGlobal("requestIdleCallback", (callback: () => void) => {
      handle += 1;
      const id = handle;
      const run = (): void => {
        handles.delete(id);
        callback();
      };
      handles.set(id, run);
      idle.push(run);
      return id;
    });
    vi.stubGlobal("cancelIdleCallback", (id: number) => {
      const run = handles.get(id);
      if (run) idle = idle.filter((pending) => pending !== run);
    });
  });

  function startSweep(): void {
    renderHook(() => useConversationPreloadIntent());
    vi.advanceTimersByTime(1_500);
  }

  it("preloads only the rows in view and not in an inert subtree", async () => {
    addRow(1);
    addRow(2, BELOW_VIEW);
    const collapsed = document.body.appendChild(document.createElement("div"));
    collapsed.setAttribute("inert", "");
    addRow(3, IN_VIEW, collapsed);
    addRow(4);

    startSweep();
    await runIdle();

    expect(preloadedIds()).toEqual([1, 4]);
    expect(mocks.preload).toHaveBeenCalledWith(1, IDLE_SNAPSHOT_REFRESH_MS);
  });

  it("preloads one conversation once, whichever of its rows is in view", async () => {
    addRow(5, BELOW_VIEW);
    addRow(5);

    startSweep();
    await runIdle();

    expect(preloadedIds()).toEqual([5]);
  });

  it(`preloads at most ${SWEEP_MAX_ROWS} rows per pass`, async () => {
    for (let featureId = 1; featureId <= SWEEP_MAX_ROWS + 10; featureId += 1) addRow(featureId);

    startSweep();
    await runIdle();

    expect(preloadedIds()).toHaveLength(SWEEP_MAX_ROWS);
  });

  it("skips a working conversation, then refreshes it once when it stops", async () => {
    addRow(1);
    addRow(2);
    setRunning([2]);

    startSweep();
    await runIdle();
    expect(preloadedIds()).toEqual([1]);

    // Idle at the next pass: refreshed whatever its snapshot's age.
    setRunning([]);
    mocks.preload.mockClear();
    vi.advanceTimersByTime(20_000);
    await runIdle();
    expect(mocks.preload).toHaveBeenCalledWith(2, 0);
    expect(mocks.preload).toHaveBeenCalledWith(1, IDLE_SNAPSHOT_REFRESH_MS);

    // Only once: the pass after treats it as any idle conversation.
    mocks.preload.mockClear();
    vi.advanceTimersByTime(20_000);
    await runIdle();
    expect(mocks.preload).toHaveBeenCalledWith(2, IDLE_SNAPSHOT_REFRESH_MS);
  });

  it("lets a pass in progress finish instead of starting over", async () => {
    addRow(1);
    addRow(2);
    addRow(3);

    startSweep();
    await runIdle(1);
    expect(preloadedIds()).toEqual([1]);

    // The next pass is due while this one still has rows to go.
    vi.advanceTimersByTime(20_000);
    await runIdle();

    expect(preloadedIds()).toEqual([1, 2, 3]);
  });

  it("waits for one row's preload to settle before scheduling the next row", async () => {
    let resolveFirst!: () => void;
    mocks.preload.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveFirst = resolve;
        }),
    );
    addRow(1);
    addRow(2);

    startSweep();
    idle.shift()?.();
    await Promise.resolve();
    expect(preloadedIds()).toEqual([1]);
    expect(idle).toHaveLength(0);

    resolveFirst();
    await vi.advanceTimersByTimeAsync(0);
    expect(idle).toHaveLength(1);
    await runIdle();
    expect(preloadedIds()).toEqual([1, 2]);
  });

  it("uses idle time only: no deadline on its idle callbacks", () => {
    const requestIdle = vi.fn(() => 1);
    vi.stubGlobal("requestIdleCallback", requestIdle);
    addRow(1);

    startSweep();

    expect(requestIdle).toHaveBeenCalledWith(expect.any(Function), undefined);
  });
});
