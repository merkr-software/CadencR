import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import type { SessionWarningPayload } from "@/api/generated";
import { handleEnvelope, type StoreAccessors } from "./ws-envelope-handler";
import { handleMessageBatch } from "./ws-message-envelope-handler";
import { createSessionEntry, type SessionEntry, type WsSessionStore } from "./ws-session-types";

vi.mock("sonner", () => ({ toast: { error: vi.fn(), warning: vi.fn() } }));

const warning = {
  code: "PROMPT_POST_ACCEPT_FAILED",
  message: "The agent accepted your prompt, but saving its receipt failed.",
} satisfies SessionWarningPayload;

function context(mode: "running" | "compacting" | "gated" = "running"): StoreAccessors {
  const session = createSessionEntry();
  session.lifecycle =
    mode === "gated" ? { phase: "paused", reason: "permission" } : { phase: "active" };
  session.blocks = [
    {
      id: "prompt",
      type: "user_message",
      content: "hello",
      messageUuid: "prompt-uuid",
      promptDeliveryState: "pending_agent",
    },
  ];
  if (mode === "compacting") {
    session.compactRequestPending = true;
    session.pendingManualCompact = true;
    session.runtimeCompacting = true;
  }
  if (mode === "gated") {
    session.pendingPermission = {
      toolName: "Write",
      input: { path: "file.txt" },
      description: "Write a file",
      pattern: "Write",
      requestId: "gate-1",
    };
    session.pendingPermissionQueue = [session.pendingPermission];
    session.pendingRequestId = "gate-1";
    session.submittingPermissionRequestId = "gate-1";
    session.permissionResponseMessageUuids.set("gate-1", "response-uuid");
    session.pendingQuestionToolInput = { question: "Continue?" };
    session.pendingPlanApproval = { plan: "Keep working" };
  }
  let state = { sessions: { s1: session } } as unknown as WsSessionStore;
  return {
    get: () => state,
    set: vi.fn((patch: Partial<WsSessionStore>) => {
      state = { ...state, ...patch };
    }),
    getSession: (id): SessionEntry => state.sessions[id],
  };
}

function sendWarning(ctx: StoreAccessors, payload: unknown = warning, ref?: string): void {
  handleEnvelope(ctx, "s1", { domain: "session", action: "warning", payload, ref });
}

describe("nonterminal session warnings", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each(["running", "compacting", "gated"] as const)(
    "shows the warning while preserving all session state when %s",
    (mode) => {
      const ctx = context(mode);
      const session = ctx.getSession("s1");
      const snapshot = structuredClone(session);

      sendWarning(ctx);

      expect(toast.warning).toHaveBeenCalledExactlyOnceWith(warning.message, {
        id: `session-warning:s1:${warning.code}`,
      });
      expect(ctx.set).not.toHaveBeenCalled();
      expect(ctx.getSession("s1")).toBe(session);
      expect(session).toEqual(snapshot);
      expect(session.blocks[0].promptDeliveryState).toBe("pending_agent");
    },
  );

  it.each([warning, { code: warning.code, message: null }])(
    "does not consume a correlated command reply for warning %j",
    (payload) => {
      const ctx = context();
      const callback = vi.fn();
      const session = ctx.getSession("s1");
      session.pendingWsRequests.set("command-1", callback);

      sendWarning(ctx, payload, "command-1");

      expect(callback).not.toHaveBeenCalled();
      expect(session.pendingWsRequests.get("command-1")).toBe(callback);
      expect(toast.warning).toHaveBeenCalledTimes(payload.message === null ? 0 : 1);
      handleEnvelope(ctx, "s1", {
        domain: "session",
        action: "acknowledged",
        ref: "command-1",
        payload: { accepted: true },
      });
      expect(callback).toHaveBeenCalledExactlyOnceWith({ accepted: true });
      expect(session.pendingWsRequests.has("command-1")).toBe(false);
    },
  );

  it.each([
    null,
    {},
    { code: "SAVE_FAILED" },
    { message: "Save failed" },
    { code: null, message: "Save failed" },
    { code: "SAVE_FAILED", message: 42 },
    { code: " ", message: "Save failed" },
    { code: "SAVE_FAILED", message: " " },
    { code: "SAVE_FAILED", error: "legacy alias" },
  ])("surfaces malformed payload %j without changing session state", (payload) => {
    const ctx = context("gated");
    const session = ctx.getSession("s1");
    const snapshot = structuredClone(session);
    sendWarning(ctx, payload);
    expect(toast.warning).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledExactlyOnceWith(
      "The service sent an invalid session warning. The conversation was not changed.",
    );
    expect(ctx.set).not.toHaveBeenCalled();
    expect(session).toEqual(snapshot);
  });

  it("continues the same stream and accepts its subsequent completion", () => {
    const ctx = context();
    const streamEvent = (event: Record<string, unknown>): Record<string, unknown> => ({
      type: "stream_event",
      event,
    });
    handleMessageBatch(ctx, "s1", [
      {
        blocks: [
          streamEvent({
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "Before " },
          }),
        ],
      },
    ]);
    const session = ctx.getSession("s1");
    const streamState = session.streamingState;
    const streams = new Map(
      [...streamState.streams].map(([id, stream]) => [id, structuredClone(stream)]),
    );
    vi.mocked(ctx.set).mockClear();
    sendWarning(ctx);
    expect(ctx.getSession("s1")).toBe(session);
    expect(ctx.set).not.toHaveBeenCalled();
    expect(session.streamingState).toBe(streamState);
    expect(streamState.streams).toEqual(streams);
    handleMessageBatch(ctx, "s1", [
      {
        blocks: [
          streamEvent({
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "after" },
          }),
          streamEvent({ type: "content_block_stop", index: 0 }),
        ],
      },
    ]);
    handleEnvelope(ctx, "s1", {
      domain: "session",
      action: "ended",
      payload: { reason: "provider_complete", received_prompt_message_uuids: ["prompt-uuid"] },
    });
    const completed = ctx.getSession("s1");
    expect(completed.lifecycle).toEqual({ phase: "terminal", reason: "completed" });
    expect(completed.blocks.find((block) => block.type === "text")?.content).toBe("Before after");
    expect(
      completed.blocks.find((block) => block.type === "user_message")?.promptDeliveryState,
    ).toBe("received_agent");
  });
});
