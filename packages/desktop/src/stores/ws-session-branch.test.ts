import { describe, expect, it, vi } from "vitest";

vi.mock("sonner", () => ({
  toast: {
    loading: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    dismiss: vi.fn(),
  },
}));
vi.mock("@/lib/queryClient", () => ({ queryClient: { invalidateQueries: vi.fn() } }));
vi.mock("@/api/generated", () => ({
  getListFeaturesQueryKey: (params: { project_id: number }) => ["/api/features", params],
}));
import { toast } from "sonner";
import type { AgentBlockData } from "@/types/agent-block";
import { createSessionEntry, type WsSessionStore } from "./ws-session-types";
import {
  BRANCH_REPLY_TIMEOUT_MS,
  forkFromMessage,
  resolveBranchConfirm,
  rewindToMessage,
  truncateBlocksAtMessage,
  type BranchDeps,
} from "./ws-session-branch";

function block(id: string, type: AgentBlockData["type"], content: string): AgentBlockData {
  return { id, type, content };
}

function makeHarness(reply: unknown) {
  const session = {
    ...createSessionEntry(),
    serverSessionId: "55",
    featureId: 7,
    blocks: [
      block("msg-1", "user_message", "first"),
      block("msg-2", "text", "answer"),
      block("msg-3", "user_message", "second"),
      block("msg-4", "text", "answer2"),
    ],
  };
  let state = {
    sessions: { "ws-1": session },
    branchConfirm: null,
    composerPrefill: null,
    forkNavigation: null,
  } as unknown as WsSessionStore;
  const sendRequest = vi.fn().mockResolvedValue(reply);
  const deps: BranchDeps = {
    get: () => state,
    set: (partial) => {
      state = { ...state, ...partial };
    },
    sendRequest,
  };
  return { deps, sendRequest, getState: () => state };
}

function harnessWithBlocks(blocks: AgentBlockData[]) {
  const session = { ...createSessionEntry(), serverSessionId: "55", featureId: 7, blocks };
  let state = {
    sessions: { "ws-1": session },
    branchConfirm: null,
    composerPrefill: null,
    forkNavigation: null,
  } as unknown as WsSessionStore;
  return {
    get: () => state,
    set: (partial: Partial<WsSessionStore>) => {
      state = { ...state, ...partial };
    },
    ids: () => state.sessions["ws-1"].blocks.map((b) => b.id),
  };
}

describe("truncateBlocksAtMessage", () => {
  it("drops blocks at or after the cut message", () => {
    const { deps, getState } = makeHarness(null);
    truncateBlocksAtMessage(deps.get, deps.set, "ws-1", 3);
    expect(getState().sessions["ws-1"].blocks.map((b) => b.id)).toEqual(["msg-1", "msg-2"]);
  });

  it("keeps earlier live (id-less) blocks when rewinding a later message", () => {
    // Repro of the wipe bug: a session chatted in live has canonical user /
    // streaming blocks with no `msg-<id>`. Rewinding the 2nd message (stamped
    // `messageDbId: 20`) must preserve turn 1, not drop the whole view.
    const h = harnessWithBlocks([
      { id: "canonical-user-1", type: "user_message", content: "first", messageDbId: 10 },
      { id: "ws-assist-1", type: "text", content: "answer one" },
      { id: "canonical-user-2", type: "user_message", content: "second", messageDbId: 20 },
      { id: "ws-assist-2", type: "text", content: "answer two" },
    ]);
    truncateBlocksAtMessage(h.get, h.set, "ws-1", 20);
    expect(h.ids()).toEqual(["canonical-user-1", "ws-assist-1"]);
  });

  it("resolves the cut by stamped messageDbId on a live block", () => {
    const h = harnessWithBlocks([
      { id: "msg-10", type: "user_message", content: "first" },
      { id: "ws-assist-1", type: "text", content: "answer one" },
      { id: "canonical-user-2", type: "user_message", content: "second", messageDbId: 20 },
    ]);
    truncateBlocksAtMessage(h.get, h.set, "ws-1", 20);
    expect(h.ids()).toEqual(["msg-10", "ws-assist-1"]);
  });

  it("empties the conversation when rewinding the only/first message", () => {
    const h = harnessWithBlocks([
      { id: "canonical-user-1", type: "user_message", content: "only", messageDbId: 10 },
      { id: "ws-assist-1", type: "text", content: "answer" },
    ]);
    truncateBlocksAtMessage(h.get, h.set, "ws-1", 10);
    expect(h.ids()).toEqual([]);
  });

  it("leaves the view untouched when the cut block is absent", () => {
    const h = harnessWithBlocks([
      { id: "canonical-user-1", type: "user_message", content: "first", messageDbId: 10 },
    ]);
    truncateBlocksAtMessage(h.get, h.set, "ws-1", 999);
    expect(h.ids()).toEqual(["canonical-user-1"]);
  });
});

// Found in QA: a fork that took over the 10 s default timed out, and its late
// failure reply was then shown as the turn's own error.
it("waits for the rewind and fork replies longer than an ordinary request", async () => {
  const { deps, sendRequest } = makeHarness({ code: "BRANCH_SURGERY_FAILED", message: "x" });
  await rewindToMessage(deps, "ws-1", 3);
  await forkFromMessage(deps, "ws-1", 3);
  expect(sendRequest.mock.calls.map((call) => call[2])).toEqual([
    BRANCH_REPLY_TIMEOUT_MS,
    BRANCH_REPLY_TIMEOUT_MS,
  ]);
  expect(BRANCH_REPLY_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000);
});

// Found in QA: a fork Codex refused led its toast with the whole internal
// chain ("transcript surgery failed: Codex app-server branching failed: …").
it.each([
  ["fork", "The conversation couldn't be forked. Nothing was changed."],
  ["rewind", "The conversation couldn't be rewound. Nothing was changed."],
] as const)(
  "a refused %s leads with plain words and keeps the error as detail",
  async (kind, title) => {
    const message =
      "The conversation couldn't be branched: transcript surgery failed: Codex app-server branching failed: app-server returned error -32600: thread not loaded: 00000000-0000-7000-8000-000000000000";
    const { deps } = makeHarness({ code: "BRANCH_SURGERY_FAILED", message });
    vi.mocked(toast.error).mockClear();

    await (kind === "fork" ? forkFromMessage : rewindToMessage)(deps, "ws-1", 3);

    expect(toast.error).toHaveBeenCalledWith(title, {
      id: "branch-ws-1",
      description: message,
    });
  },
);

describe("rewindToMessage", () => {
  it("truncates blocks and prefills the composer on success", async () => {
    const { deps, sendRequest, getState } = makeHarness({
      sessionId: "55",
      messageId: 3,
      draftText: "second",
      codeRestored: true,
      codeRestoreError: null,
    });
    await rewindToMessage(deps, "ws-1", 3);
    expect(sendRequest).toHaveBeenCalledOnce();
    expect(getState().sessions["ws-1"].blocks.map((b) => b.id)).toEqual(["msg-1", "msg-2"]);
    expect(getState().composerPrefill).toMatchObject({ sessionId: "ws-1", text: "second" });
  });

  it("warns but still rewinds when code restore failed", async () => {
    const { toast } = await import("sonner");
    const { deps, getState } = makeHarness({
      sessionId: "55",
      messageId: 3,
      draftText: "second",
      codeRestored: false,
      codeRestoreError: "git restore failed",
    });
    await rewindToMessage(deps, "ws-1", 3);
    // Conversation is still rewound (the primary effect) ...
    expect(getState().sessions["ws-1"].blocks.map((b) => b.id)).toEqual(["msg-1", "msg-2"]);
    // ... but the code-restore failure is surfaced, not the benign success.
    expect(toast.warning).toHaveBeenCalledWith(
      "Rewound, but restoring the code failed.",
      expect.objectContaining({ description: "git restore failed" }),
    );
  });

  it("opens the confirm dialog (no mutation) when the worktree is dirty", async () => {
    const { deps, getState } = makeHarness({
      kind: "rewind",
      reason: "Rewinding will discard uncommitted changes.",
      sessionId: "55",
      messageId: 3,
    });
    await rewindToMessage(deps, "ws-1", 3);
    expect(getState().branchConfirm).toMatchObject({ sessionId: "ws-1", messageId: 3 });
    expect(getState().sessions["ws-1"].blocks).toHaveLength(4);
    expect(getState().composerPrefill).toBeNull();
  });

  it("leaves the conversation intact on a typed error", async () => {
    const { deps, getState } = makeHarness({ code: "NO_WORKTREE", message: "no worktree yet" });
    await rewindToMessage(deps, "ws-1", 3);
    expect(getState().sessions["ws-1"].blocks).toHaveLength(4);
    expect(getState().composerPrefill).toBeNull();
  });
});

describe("resolveBranchConfirm", () => {
  it("re-runs the rewind with confirmDiscard when confirmed", async () => {
    const { deps, sendRequest, getState } = makeHarness({
      sessionId: "55",
      messageId: 3,
      draftText: "second",
    });
    // Seed a pending confirm, then confirm it.
    deps.set({ branchConfirm: { sessionId: "ws-1", messageId: 3, kind: "rewind", reason: "x" } });
    resolveBranchConfirm(deps, true);
    await Promise.resolve();
    await Promise.resolve();
    expect(sendRequest).toHaveBeenCalledOnce();
    const envelope = sendRequest.mock.calls[0][1] as { payload: { confirm_discard: boolean } };
    expect(envelope.payload.confirm_discard).toBe(true);
    expect(getState().branchConfirm).toBeNull();
  });
});

describe("forkFromMessage", () => {
  it("refreshes the feature list and parks navigation to the new feature", async () => {
    const { deps, sendRequest, getState } = makeHarness({
      sourceSessionId: "55",
      newSessionId: "56",
      newFeatureId: 8,
      projectId: 7,
      draftText: "second",
    });
    await forkFromMessage(deps, "ws-1", 3);
    expect(sendRequest).toHaveBeenCalledOnce();
    const { queryClient } = await import("@/lib/queryClient");
    expect(queryClient.invalidateQueries).toHaveBeenCalled();
    expect(getState().forkNavigation).toMatchObject({
      sessionId: "ws-1",
      projectId: 7,
      featureId: 8,
    });
  });

  it("does not navigate when the reply lacks a new feature", async () => {
    const { deps, getState } = makeHarness({
      sourceSessionId: "55",
      newSessionId: "56",
      draftText: "second",
    });
    await forkFromMessage(deps, "ws-1", 3);
    expect(getState().forkNavigation).toBeNull();
  });
});
