import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  applySnapshot,
  handleAppEnvelope,
  lookupFeature,
  resetEditorInvalidationSchedulingForTest,
} from "./session-status-handlers";
import { notifyAgentNeedsInput } from "@/lib/notify-agent-done";
import { queryClient } from "@/lib/queryClient";
import { getInvalidatePredicate } from "@/test-utils";

vi.mock("@/lib/notify-agent-done", () => ({
  isViewingFeature: vi.fn(() => false),
  notifyAgentDone: vi.fn(),
  notifyAgentNeedsInput: vi.fn(),
}));

function fireFileTreeChanged(): void {
  handleAppEnvelope("editor", "file_tree.changed", {});
}

describe("handleAppEnvelope · editor/file_tree.changed", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetEditorInvalidationSchedulingForTest();
  });
  afterEach(() => {
    resetEditorInvalidationSchedulingForTest();
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("coalesces a burst of file-tree changes into one leading + one trailing refetch", () => {
    const spy = vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue();

    // A build / agent writing files fires a burst faster than the settle window.
    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(100);
      fireFileTreeChanged();
    }

    // Only the leading edge has fired so far — the rest are coalescing.
    expect(spy).toHaveBeenCalledTimes(1);

    // Let the churn settle → exactly one trailing refetch.
    vi.advanceTimersByTime(1_500);
    expect(spy).toHaveBeenCalledTimes(2);

    // No further churn → window closes, no extra invalidations.
    vi.advanceTimersByTime(5_000);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("refetches editor content and tree data without re-counting the whole tree", () => {
    const spy = vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue();

    fireFileTreeChanged();

    const predicate = getInvalidatePredicate(spy.mock.calls[0]?.[0]);
    expect(predicate({ queryKey: ["/api/editor/read", { path: "a.ts" }] })).toBe(true);
    expect(predicate({ queryKey: ["/api/editor/read-image", { path: "a.png" }] })).toBe(true);
    expect(predicate({ queryKey: ["/api/editor/tree", {}] })).toBe(true);
    expect(predicate({ queryKey: ["/api/editor/tree-all", {}] })).toBe(true);
    expect(predicate({ queryKey: ["/api/editor/tree-count", {}] })).toBe(false);
    expect(predicate({ queryKey: ["/api/editor/search", { q: "x" }] })).toBe(true);
    // Git content queries must not be swept up here — that was the storm.
    expect(predicate({ queryKey: ["/api/git/diff", { feature_id: 7 }] })).toBe(false);
    expect(predicate({ queryKey: ["/api/git/stats", { feature_id: 7 }] })).toBe(false);
  });

  it("refetches the project list when a theme file changes", () => {
    const spy = vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue();

    // A theme's label is the name of its project in the sidebar, and the
    // backend renames the project from this same write.
    handleAppEnvelope("app", "theme_event", { id: "vamp" });

    expect(spy).toHaveBeenCalledWith({ queryKey: ["/api/themes"] });
    expect(spy).toHaveBeenCalledWith({ queryKey: ["/api/projects"] });
  });

  it("treats a change after the window as a fresh leading edge", () => {
    const spy = vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue();

    fireFileTreeChanged(); // leading — fires now
    vi.advanceTimersByTime(1_500); // window closes, no trailing (single event)
    expect(spy).toHaveBeenCalledTimes(1);

    fireFileTreeChanged(); // fresh leading — fires now
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("refetches only the document previews the event names", () => {
    const spy = vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue();
    const documentKey = (file_path: string) => [
      "/api/editor/read-document",
      { project_id: 1, feature_id: 2, file_path },
    ];

    fireFileTreeChanged();
    const editorWave = getInvalidatePredicate(spy.mock.calls[0]?.[0]);
    expect(editorWave({ queryKey: documentKey("out/report.xlsx") })).toBe(false);
    expect(spy).toHaveBeenCalledTimes(1);

    handleAppEnvelope("editor", "file_tree.changed", { documents: ["out/report.xlsx"] });
    const documents = getInvalidatePredicate(spy.mock.calls.at(-1)?.[0]);
    expect(documents({ queryKey: documentKey("out/report.xlsx") })).toBe(true);
    expect(documents({ queryKey: documentKey("deck.pptx") })).toBe(false);
    expect(documents({ queryKey: ["/api/editor/read", { path: "out/report.xlsx" }] })).toBe(false);
  });

  it("refreshes managed inventory without rereading authored themes or project settings", () => {
    const spy = vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue();
    handleAppEnvelope("app", "theme_event", { id: "managed:midnight" });
    expect(spy).toHaveBeenCalledOnce();
    expect(spy).toHaveBeenCalledWith({ queryKey: ["marketplace", "managed-themes"] });
  });
});

describe("lookupFeature", () => {
  afterEach(() => queryClient.clear());

  it("skips per-feature queries that share the feature lists' key prefix", () => {
    // A pending gate cached (or restored from the persisted cache) under the
    // lists' prefix used to throw here and abort the whole status snapshot.
    queryClient.setQueryData(["/api/features", 7, "pending-gate", "req-1"], {
      request_id: "req-1",
    });
    queryClient.setQueryData(["/api/features", { project_id: 1 }], [{ id: 7, title: "Seven" }]);
    expect(lookupFeature(7)).toMatchObject({ id: 7, title: "Seven" });
    expect(lookupFeature(8)).toBeUndefined();
  });
});

describe("applySnapshot", () => {
  it("returns the sessions newly awaiting the user instead of notifying", () => {
    const states = {
      7: { feature_id: 70, status: "question", kind: "permission" },
      8: { feature_id: 80, status: "agent" },
      9: { feature_id: 90, status: "question", kind: "question" },
    };
    const current = {
      9: { status: "question" as const, kind: "question" as const, featureId: 90, seq: 1 },
    };

    const { bySession, transitions } = applySnapshot(current, { seq: 2, states });

    expect(Object.keys(bySession)).toEqual(["7", "8", "9"]);
    expect(transitions).toEqual([{ featureId: 70, prevStatus: undefined, nextStatus: "question" }]);
    expect(notifyAgentNeedsInput).not.toHaveBeenCalled();
  });
});
