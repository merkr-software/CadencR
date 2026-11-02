import { SessionTransportRegistry } from "./ws-session-transport";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { handleEnvelope, type StoreAccessors } from "./ws-envelope-handler";
import { createSessionEntry, type SessionEntry, type WsSessionStore } from "./ws-session-types";
import { transitionTurn } from "./ws-turn-lifecycle";

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

function context(): StoreAccessors {
  const session = createSessionEntry();
  session.lifecycle = transitionTurn(session.lifecycle, { type: "prompt_sent" });
  session.blocks = [
    {
      id: "prompt",
      type: "user_message",
      content: "hello",
      promptDeliveryState: "pending_agent",
    },
  ];
  let state = { sessions: { s1: session } } as unknown as WsSessionStore;
  return {
    get: () => state,
    set: (patch) => {
      state = { ...state, ...patch };
    },
    transport: new SessionTransportRegistry(),
    getSession: (id): SessionEntry => state.sessions[id],
  };
}

function status(ctx: StoreAccessors, payload: unknown): void {
  handleEnvelope(ctx, "s1", { domain: "session", action: "persistence_status", payload });
}

describe("transcript persistence status", () => {
  beforeEach(() => vi.clearAllMocks());

  it("surfaces saving failures without stopping the turn or failing pending prompts", () => {
    const ctx = context();
    const before = ctx.getSession("s1");
    status(ctx, { status: "degraded", message: "History is temporarily incomplete." });
    const after = ctx.getSession("s1");
    expect(after.persistenceStatus?.status).toBe("degraded");
    expect(after.lifecycle).toBe(before.lifecycle);
    expect(after.blocks).toBe(before.blocks);
    expect(after.blocks[0].promptDeliveryState).toBe("pending_agent");
    expect(after.streamHealth).toBe(before.streamHealth);
  });

  it("retains unresolved warnings after transport recovery and turn completion", () => {
    const ctx = context();
    const warning = { status: "failed", message: "Some output could not be saved." };
    status(ctx, warning);
    handleEnvelope(ctx, "s1", {
      domain: "session",
      action: "stream_status",
      payload: { state: "recovered" },
    });
    handleEnvelope(ctx, "s1", {
      domain: "session",
      action: "ended",
      payload: { reason: "provider_complete" },
    });
    expect(ctx.getSession("s1").persistenceStatus).toEqual(warning);
    expect(ctx.getSession("s1").lifecycle.phase).toBe("terminal");
  });

  it("announces confirmed recovery once and treats healthy replay as quiet", () => {
    const ctx = context();
    status(ctx, { status: "recovered", message: "Conversation history saved." });
    expect(toast.success).not.toHaveBeenCalled();
    status(ctx, { status: "degraded", message: "Saving interrupted." });
    const recovered = { status: "recovered", message: "Conversation history saved." };
    status(ctx, recovered);
    status(ctx, recovered);
    expect(ctx.getSession("s1").persistenceStatus).toEqual(recovered);
    expect(toast.success).toHaveBeenCalledExactlyOnceWith(recovered.message, {
      id: "transcript-persistence:s1",
    });
  });

  it.each([null, {}, { status: "ok", message: "saved" }, { status: "recovered", message: " " }])(
    "does not clear a warning for malformed payload %j",
    (payload) => {
      const ctx = context();
      status(ctx, { status: "failed", message: "Unsaved output remains." });
      const before = ctx.getSession("s1");
      status(ctx, payload);
      expect(ctx.getSession("s1")).toBe(before);
      expect(toast.error).toHaveBeenCalledOnce();
    },
  );
});
