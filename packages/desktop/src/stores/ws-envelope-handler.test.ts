import { describe, expect, it, vi } from "vitest";
import { toast } from "sonner";

import type { AgentBlockData } from "@/components/AgentBlock";
import { handleEnvelope, type StoreAccessors } from "./ws-envelope-handler";
import { createSessionEntry, type SessionEntry, type WsSessionStore } from "./ws-session-types";
import { transitionTurn } from "./ws-turn-lifecycle";
import { useGitStatusStore } from "./useGitStatusStore";

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

function createTestContext(session: SessionEntry): StoreAccessors {
  let state = { sessions: { s1: session } } as unknown as WsSessionStore;

  return {
    get: (): WsSessionStore => state,
    set: (partial: Partial<WsSessionStore>): void => {
      state = { ...state, ...partial };
    },
    getSession: (sessionId: string): SessionEntry => state.sessions[sessionId],
  };
}

function makeTaskBlock(toolUseId: string): AgentBlockData {
  return {
    id: `block-${toolUseId}`,
    type: "tool_call",
    content: "",
    toolName: "Task",
    toolUseId,
    childBlocks: [],
    taskComplete: false,
  };
}

describe("handleEnvelope turn_complete", () => {
  it("marks every active subtask stream complete", () => {
    const session = createSessionEntry();
    const taskA = makeTaskBlock("task-a");
    const taskB = makeTaskBlock("task-b");

    session.blocks = [taskA, taskB];
    session.lifecycle = transitionTurn(session.lifecycle, { type: "prompt_sent" });
    session.streamingState.toolUseIdToBlock.set("task-a", taskA);
    session.streamingState.toolUseIdToBlock.set("task-b", taskB);
    session.streamingState.streams.set("child-a", {
      model: null,
      contentBlockIds: new Map(),
      parentToolUseId: "task-a",
    });
    session.streamingState.streams.set("child-b", {
      model: null,
      contentBlockIds: new Map(),
      parentToolUseId: "task-b",
    });

    const ctx = createTestContext(session);

    handleEnvelope(ctx, "s1", {
      domain: "session",
      action: "turn_complete",
      payload: {},
    });

    const updated = ctx.getSession("s1");
    expect(updated.lifecycle).toEqual({ phase: "terminal", reason: "completed" });
    expect(updated.blocks[0].taskComplete).toBe(true);
    expect(updated.blocks[1].taskComplete).toBe(true);
    for (const stream of updated.streamingState.streams.values()) {
      expect(stream.parentToolUseId).toBeNull();
    }
  });
});

describe("handleEnvelope cleared", () => {
  it("resets prepend anchoring state when a clear divider starts a new turn history", () => {
    const session = createSessionEntry();
    session.blocks = [{ id: "old", type: "text", content: "old content" }];
    session.rootBlocks = session.blocks;
    session.historyPrependDisplayOffset = 42;
    const ctx = createTestContext(session);

    handleEnvelope(ctx, "s1", {
      domain: "session",
      action: "cleared",
      payload: { previous_session_id: "previous-session" },
    });

    const updated = ctx.getSession("s1");
    expect(updated.historyPrependDisplayOffset).toBe(0);
    expect(updated.blocks.map((block) => block.type)).toEqual(["text", "clear_divider"]);
    expect(updated.rootBlocks.map((block) => block.type)).toEqual(["text", "clear_divider"]);
  });
});

describe("handleEnvelope mode.changed", () => {
  it("accepts a mode that exists in the active provider's catalog", () => {
    const session = createSessionEntry();
    session.currentProviderId = "claude_code";
    session.permissionMode = "acceptEdits";
    const ctx = createTestContext(session);

    handleEnvelope(ctx, "s1", {
      domain: "session",
      action: "mode.changed",
      payload: { mode: "auto" },
    });

    expect(ctx.getSession("s1").permissionMode).toBe("auto");
  });

  it("drops a mode the active provider doesn't support (stale FE catalog guard)", () => {
    const session = createSessionEntry();
    // OpenCode has no `auto` mode — the backend would reject it via
    // MODE_NOT_SUPPORTED, but if a stale envelope reaches us we still must
    // not poison the chip state.
    session.currentProviderId = "opencode";
    session.permissionMode = "acceptEdits";
    const ctx = createTestContext(session);

    handleEnvelope(ctx, "s1", {
      domain: "session",
      action: "mode.changed",
      payload: { mode: "auto" },
    });

    expect(ctx.getSession("s1").permissionMode).toBe("acceptEdits");
  });

  it("accepts project-scoped OpenCode agent modes", () => {
    const session = createSessionEntry();
    session.currentProviderId = "opencode";
    session.permissionMode = "acceptEdits";
    const ctx = createTestContext(session);

    handleEnvelope(ctx, "s1", {
      domain: "session",
      action: "mode.changed",
      payload: { mode: "opencodeAgent:documentor" },
    });

    expect(ctx.getSession("s1").permissionMode).toBe("opencodeAgent:documentor");
  });
});

describe("handleEnvelope provider.set.ok", () => {
  it("updates provider state but does NOT touch permissionMode (mode.changed follows)", () => {
    const session = createSessionEntry();
    session.currentProviderId = "claude_code";
    session.permissionMode = "plan";
    const ctx = createTestContext(session);

    handleEnvelope(ctx, "s1", {
      domain: "session",
      action: "provider.set.ok",
      payload: { provider: "codex_cli" },
    });

    const updated = ctx.getSession("s1");
    expect(updated.currentProviderId).toBe("codex_cli");
    expect(updated.runtimeProvider).toBe("codex_cli");
    expect(updated.supportsPromptReceipts).toBe(false);
    // No optimistic update — the chip stays on the old mode until the backend
    // emits a `mode.changed` envelope as the second half of the provider switch.
    expect(updated.permissionMode).toBe("plan");
  });

  it("updates prompt receipt support from provider capabilities", () => {
    const session = createSessionEntry();
    const ctx = createTestContext(session);

    handleEnvelope(ctx, "s1", {
      domain: "session",
      action: "provider.set.ok",
      payload: { provider: "opencode", supports_prompt_receipts: true },
    });

    expect(ctx.getSession("s1").supportsPromptReceipts).toBe(true);
  });

  it("subsequent mode.changed from the backend lands the chip on the new provider's default", () => {
    const session = createSessionEntry();
    session.currentProviderId = "claude_code";
    session.permissionMode = "plan";
    const ctx = createTestContext(session);

    handleEnvelope(ctx, "s1", {
      domain: "session",
      action: "provider.set.ok",
      payload: { provider: "codex_cli" },
    });
    handleEnvelope(ctx, "s1", {
      domain: "session",
      action: "mode.changed",
      payload: { mode: "default" },
    });

    expect(ctx.getSession("s1").permissionMode).toBe("default");
  });
});

describe("handleEnvelope commands.list", () => {
  it("stores command kind and defaults missing kind to command", () => {
    const session = createSessionEntry();
    session.slashCommandsRequestRef = "commands-1";
    session.slashCommandsLoading = true;
    const ctx = createTestContext(session);

    handleEnvelope(ctx, "s1", {
      domain: "commands",
      action: "list",
      ref: "commands-1",
      payload: {
        commands: [
          { name: "review", description: "Review code", kind: "command" },
          { name: "finish-job", description: "Finish safely", kind: "skill" },
          { name: "compact", description: "Compact context" },
        ],
      },
    });

    expect(ctx.getSession("s1").slashCommands).toEqual([
      { name: "review", description: "Review code", kind: "command" },
      { name: "finish-job", description: "Finish safely", kind: "skill" },
      { name: "compact", description: "Compact context", kind: "command" },
    ]);
    expect(ctx.getSession("s1").slashCommandsLoading).toBe(false);
  });
});

describe("handleEnvelope workflow worktree events", () => {
  it("bumps the per-feature watcher epoch on worktree.created", () => {
    // The git-status subscription hook listens to this counter so it can
    // re-issue subscribe and force the backend to re-resolve `worktree_path`
    // once the worktree exists. Drives both feature-view and ws-session.
    useGitStatusStore.setState({ byFeature: {}, errorByFeature: {}, watcherEpoch: {} });
    const ctx = createTestContext(createSessionEntry());

    handleEnvelope(ctx, "s1", {
      domain: "workflow",
      action: "worktree.created",
      payload: { feature_id: 42, path: "/tmp/wt", branch: "feature/x" },
    });

    expect(useGitStatusStore.getState().watcherEpoch[42]).toBe(1);
  });

  it("also bumps on worktree.ready (re-emit path on a fresh frontend session)", () => {
    useGitStatusStore.setState({ byFeature: {}, errorByFeature: {}, watcherEpoch: { 42: 5 } });
    const ctx = createTestContext(createSessionEntry());

    handleEnvelope(ctx, "s1", {
      domain: "workflow",
      action: "worktree.ready",
      payload: { feature_id: 42 },
    });

    expect(useGitStatusStore.getState().watcherEpoch[42]).toBe(6);
  });

  it("does not bump for unrelated workflow envelopes", () => {
    useGitStatusStore.setState({ byFeature: {}, errorByFeature: {}, watcherEpoch: {} });
    const ctx = createTestContext(createSessionEntry());

    handleEnvelope(ctx, "s1", {
      domain: "workflow",
      action: "worktree.creating",
      payload: { feature_id: 42 },
    });

    expect(useGitStatusStore.getState().watcherEpoch[42]).toBeUndefined();
  });
});

describe("handleEnvelope error handling", () => {
  it("routes MODE_NOT_SUPPORTED to a toast and leaves the agent stream untouched", () => {
    vi.mocked(toast.error).mockClear();
    const session = createSessionEntry();
    session.lifecycle = { phase: "idle" } as SessionEntry["lifecycle"];
    const ctx = createTestContext(session);

    handleEnvelope(ctx, "s1", {
      domain: "session",
      action: "error",
      payload: {
        code: "MODE_NOT_SUPPORTED",
        message: "Provider opencode does not support permission mode auto",
      },
    });

    expect(toast.error).toHaveBeenCalledWith(
      "Provider opencode does not support permission mode auto",
    );
    const updated = ctx.getSession("s1");
    // Lifecycle untouched (no turn was active) and no error block injected.
    expect(updated.lifecycle).toEqual({ phase: "idle" });
    expect(updated.blocks).toHaveLength(0);
  });

  it("MODE_REJECTED_BY_CLI auto-advances past the rejected mode and toasts", () => {
    vi.mocked(toast.error).mockClear();
    const session = createSessionEntry();
    session.lifecycle = { phase: "idle" } as SessionEntry["lifecycle"];
    session.currentProviderId = "claude_code";
    session.runtimeProvider = "claude_code";
    session.permissionMode = "auto";
    const setPermissionMode = vi.fn();
    let state = {
      sessions: { s1: session },
      setPermissionMode,
    } as unknown as WsSessionStore;
    const ctx: StoreAccessors = {
      get: (): WsSessionStore => state,
      set: (partial: Partial<WsSessionStore>): void => {
        state = { ...state, ...partial };
      },
      getSession: (id: string): SessionEntry => state.sessions[id],
    };

    handleEnvelope(ctx, "s1", {
      domain: "session",
      action: "error",
      payload: {
        code: "MODE_REJECTED_BY_CLI",
        message: "auto mode unavailable for this model",
        mode: "auto",
      },
    });

    // Claude Code cycle (no opt-ins) is acceptEdits → plan → auto → wrap to
    // acceptEdits. Skipping `auto` lands on acceptEdits.
    expect(setPermissionMode).toHaveBeenCalledWith("s1", "acceptEdits");
    expect(toast.error).toHaveBeenCalledTimes(1);
    // No inline error block injected (meta-bar action, toast only).
    expect(ctx.getSession("s1").blocks).toHaveLength(0);
  });

  it("falls back to the inline error block for ordinary errors", () => {
    vi.mocked(toast.error).mockClear();
    const session = createSessionEntry();
    const ctx = createTestContext(session);

    handleEnvelope(ctx, "s1", {
      domain: "session",
      action: "error",
      payload: { code: "SDK_ERROR", message: "SDK exploded" },
    });

    expect(toast.error).not.toHaveBeenCalled();
    const updated = ctx.getSession("s1");
    expect(updated.blocks.some((b) => b.isError)).toBe(true);
  });
});

describe("handleEnvelope stream_status", () => {
  it("flips streamHealth to degraded with reason on a degraded envelope", () => {
    const session = createSessionEntry();
    const ctx = createTestContext(session);

    handleEnvelope(ctx, "s1", {
      domain: "session",
      action: "stream_status",
      payload: { state: "degraded", reason: "no heartbeat for 60s" },
    });

    const updated = ctx.getSession("s1");
    expect(updated.streamHealth.state).toBe("degraded");
    expect(updated.streamHealth.reason).toBe("no heartbeat for 60s");
    expect(typeof updated.streamHealth.since).toBe("number");
  });

  it("clears streamHealth back to ok on a recovered envelope", () => {
    const session = createSessionEntry();
    session.streamHealth = { state: "degraded", reason: "reconnecting", since: 1 };
    const ctx = createTestContext(session);

    handleEnvelope(ctx, "s1", {
      domain: "session",
      action: "stream_status",
      payload: { state: "recovered" },
    });

    expect(ctx.getSession("s1").streamHealth.state).toBe("ok");
  });

  it("ignores envelopes with an unrecognized state without throwing", () => {
    // The handler intentionally `console.warn`s on the malformed payload —
    // silence it here so the test output stays clean.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const session = createSessionEntry();
    const ctx = createTestContext(session);

    handleEnvelope(ctx, "s1", {
      domain: "session",
      action: "stream_status",
      payload: { state: "ascended" },
    });

    expect(ctx.getSession("s1").streamHealth.state).toBe("ok");
    warnSpy.mockRestore();
  });
});
