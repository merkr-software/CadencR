// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import type { RestartContinuationEntry, RestartContinuationReport } from "@/api/generated";
import {
  applyRestartContinuationsEvent,
  describeRestartContinuations,
} from "@/stores/restart-continuations";

const navigate = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock("@/router", () => ({ router: { navigate } }));

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  }),
}));

function entry(overrides: Partial<RestartContinuationEntry> = {}): RestartContinuationEntry {
  return {
    session_id: 1,
    feature_id: 10,
    project_id: 100,
    feature_title: "Fix login",
    outcome: "resumed",
    reason: null,
    ...overrides,
  };
}

function report(overrides: Partial<RestartContinuationReport> = {}): RestartContinuationReport {
  return {
    boot_id: "boot-1",
    app_version: "0.16.0",
    previous_version: null,
    entries: [entry()],
    error: null,
    ...overrides,
  };
}

describe("describeRestartContinuations", () => {
  it("names the resumed agents and says the app was updated", () => {
    const content = describeRestartContinuations(
      report({
        previous_version: "0.15.0",
        entries: [
          entry(),
          entry({ session_id: 2, feature_id: 20, feature_title: "Docs" }),
          entry({ session_id: 3, feature_id: 30, feature_title: "" }),
          entry({ session_id: 4, feature_id: 40, feature_title: "Release" }),
        ],
      }),
    );
    expect(content).toEqual({
      tone: "success",
      title: "Cadencr updated to v0.16.0",
      description:
        "Resumed 4 agents that were working: Fix login, Docs, Untitled conversation and 1 more.",
      open: null,
    });
  });

  it("offers to open the conversation when only one is concerned", () => {
    const content = describeRestartContinuations(report());
    expect(content?.title).toBe("Cadencr restarted");
    expect(content?.description).toBe("Resumed 1 agent that was working: Fix login.");
    expect(content?.open).toEqual({ projectId: 100, featureId: 10 });
  });

  it("explains every agent that was not resumed, and warns on failures", () => {
    const content = describeRestartContinuations(
      report({
        entries: [
          entry({ outcome: "resumed", reason: "lost_gate", feature_title: "Gate" }),
          entry({ session_id: 2, outcome: "skipped", reason: "disabled", feature_title: "Off" }),
          entry({ session_id: 3, outcome: "failed", reason: "spawn failed", feature_title: "Bad" }),
          entry({ session_id: 4, outcome: "skipped", reason: "loop_guard", feature_title: "Loop" }),
        ],
      }),
    );
    expect(content?.tone).toBe("warning");
    expect(content?.description).toBe(
      "Resumed 1 agent that was working: Gate.\n" +
        "Gate was waiting on you and will ask again.\n" +
        "Automatic resume is off, so 1 agent stayed stopped: Off.\n" +
        "Not resumed again after several restarts in a row: Loop. Open the conversation to continue.\n" +
        "Could not resume 1 agent: Bad. Open the conversation to continue.",
    );
  });

  it("stays quiet about conversations with nothing left to resume", () => {
    const content = describeRestartContinuations(
      report({
        entries: [
          entry({ outcome: "skipped", reason: "archived" }),
          entry({ session_id: 2, outcome: "skipped", reason: "already_running" }),
          entry({ session_id: 3, outcome: "skipped", reason: "stopped_on_quit" }),
          entry({ session_id: 4, outcome: "skipped", reason: "finished" }),
        ],
      }),
    );
    expect(content).toBeNull();
  });

  it("surfaces a pass that could not run", () => {
    const content = describeRestartContinuations(
      report({ entries: [], error: "Cadencr could not read which agents the restart interrupted" }),
    );
    expect(content?.tone).toBe("warning");
    expect(content?.description).toBe(
      "Cadencr could not read which agents the restart interrupted",
    );
  });
});

describe("applyRestartContinuationsEvent", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.mocked(toast.success).mockClear();
    vi.mocked(toast.warning).mockClear();
    vi.mocked(toast.error).mockClear();
    navigate.mockClear();
  });

  it("toasts each service process's report once", () => {
    applyRestartContinuationsEvent(report());
    applyRestartContinuationsEvent(report());
    expect(toast.success).toHaveBeenCalledTimes(1);

    applyRestartContinuationsEvent(report({ boot_id: "boot-2" }));
    expect(toast.success).toHaveBeenCalledTimes(2);
  });

  it("opens the resumed conversation from the toast action", async () => {
    applyRestartContinuationsEvent(report());
    const options = vi.mocked(toast.success).mock.calls[0]?.[1];
    expect(options?.action).toMatchObject({ label: "Open" });
    const action = options?.action;
    if (!action || typeof action !== "object" || !("onClick" in action)) {
      throw new Error("expected a toast action");
    }
    action.onClick({} as never);
    await vi.waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({
        to: "/projects/$projectId/features/$featureId",
        params: { projectId: "100", featureId: "10" },
      }),
    );
  });

  it("reports a malformed payload instead of dropping it", () => {
    applyRestartContinuationsEvent({ boot_id: 3 });
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(toast.success).not.toHaveBeenCalled();
  });
});
