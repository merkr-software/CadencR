import { installSessionPresentationEffects } from "./ws-session-store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWsSessionStore } from "./ws-session-store";

class MockWebSocket {
  static OPEN = 1;
  static CLOSED = 3;
  static instances: MockWebSocket[] = [];

  readyState = MockWebSocket.OPEN;
  sent: string[] = [];
  private listeners: Record<string, Array<(...args: unknown[]) => void>> = {};

  constructor(_url: string) {
    MockWebSocket.instances.push(this);
    Promise.resolve().then(() => this.fireEvent("open"));
  }

  addEventListener(event: string, cb: (...args: unknown[]) => void): void {
    (this.listeners[event] ??= []).push(cb);
  }

  removeEventListener(event: string, cb: (...args: unknown[]) => void): void {
    this.listeners[event] = (this.listeners[event] ?? []).filter((listener) => listener !== cb);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = MockWebSocket.CLOSED;
  }

  fireEvent(event: string, data?: unknown): void {
    for (const cb of this.listeners[event] ?? []) {
      cb(data ?? {});
    }
  }

  simulateMessage(envelope: { domain: string; action: string; payload: unknown }): void {
    this.fireEvent("message", { data: JSON.stringify({ id: "srv-1", ...envelope }) });
  }
}

async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

async function connectInitializedReceiptSession(): Promise<MockWebSocket> {
  const store = useWsSessionStore.getState();
  store.connect("s1");
  await tick();
  const ws = MockWebSocket.instances.at(-1);
  if (!ws) throw new Error("missing websocket");
  ws.simulateMessage({
    domain: "session",
    action: "initialized",
    payload: {
      session_id: "srv-1",
      provider: "opencode",
      supports_prompt_receipts: true,
    },
  });
  ws.simulateMessage({
    domain: "session",
    action: "message",
    payload: {
      blocks: [{ type: "assistant", message: { content: [{ type: "text", text: "working" }] } }],
    },
  });
  return ws;
}

function confirmPrompt(
  ws: MockWebSocket,
  prompt: { payload: { message_uuid: string } },
  text: string,
  messageId: number,
): void {
  ws.simulateMessage({
    domain: "session",
    action: "user_message",
    payload: {
      message_id: messageId,
      message_uuid: prompt.payload.message_uuid,
      text,
      created_at: "2026-07-12T20:00:00Z",
      prompt_delivery_state: "pending_agent",
    },
  });
}

let disposePresentation: () => void;

beforeEach(() => {
  disposePresentation = installSessionPresentationEffects({ onUserPromptDispatched: vi.fn() });
  MockWebSocket.instances = [];
  useWsSessionStore.setState({ sessions: {} });
  vi.stubGlobal("WebSocket", MockWebSocket);
  vi.stubGlobal("window", { ...globalThis.window });
});

afterEach(() => {
  disposePresentation();
  for (const sessionId of Object.keys(useWsSessionStore.getState().sessions)) {
    useWsSessionStore.getState().disconnect(sessionId);
  }
  vi.unstubAllGlobals();
});

describe("interrupt pending steering prompts", () => {
  it("keeps an unresolved steering prompt as terminal unknown after interrupt", async () => {
    const ws = await connectInitializedReceiptSession();
    const store = useWsSessionStore.getState();

    store.sendPrompt("s1", "steer now");
    const originalPrompt = JSON.parse(ws.sent.at(-1) ?? "{}");
    confirmPrompt(ws, originalPrompt, "steer now", 41);
    ws.sent = [];

    store.interrupt("s1");

    const sent = ws.sent.map((raw) => JSON.parse(raw));
    expect(sent.map((envelope) => envelope.action)).toEqual(["interrupt"]);

    ws.simulateMessage({
      domain: "session",
      action: "ended",
      payload: { reason: "turn_complete" },
    });

    const afterEnded = ws.sent.map((raw) => JSON.parse(raw));
    expect(afterEnded.map((envelope) => envelope.action)).toEqual(["interrupt"]);
    expect(
      useWsSessionStore
        .getState()
        .sessions.s1.blocks.find(
          (block) => block.messageUuid === originalPrompt.payload.message_uuid,
        )?.promptDeliveryState,
    ).toBe("delivery_unknown");
  });

  it("clears a stuck steering prompt when the backend acks it after the interrupt", async () => {
    // Regression: a steering prompt sent right before an interrupt used to stay
    // pending forever because nothing acked it. The backend now drains pending
    // receipts on turn end, so a `prompt_received` arrives after `ended` and the
    // frontend must resolve the block to "received_agent".
    const ws = await connectInitializedReceiptSession();
    const store = useWsSessionStore.getState();

    store.sendPrompt("s1", "steer now");
    const prompt = JSON.parse(ws.sent.at(-1) ?? "{}");
    confirmPrompt(ws, prompt, "steer now", 41);
    const blockId = useWsSessionStore
      .getState()
      .sessions.s1.blocks.find((b) => b.messageUuid === prompt.payload.message_uuid)?.id;
    expect(blockId).toBeDefined();

    store.interrupt("s1");
    ws.simulateMessage({
      domain: "session",
      action: "ended",
      payload: { reason: "turn_complete" },
    });
    ws.simulateMessage({
      domain: "session",
      action: "prompt_received",
      payload: { message_uuid: prompt.payload.message_uuid, delivery_state: "received_agent" },
    });

    const block = useWsSessionStore.getState().sessions.s1.blocks.find((b) => b.id === blockId);
    expect(block?.promptDeliveryState).toBe("received_agent");
  });

  it("reconciles a missed receipt at the prompt's current replay boundary", async () => {
    const ws = await connectInitializedReceiptSession();
    const store = useWsSessionStore.getState();

    store.sendPrompt("s1", "steer now");
    const prompt = JSON.parse(ws.sent.at(-1) ?? "{}");
    const messageUuid = prompt.payload.message_uuid;
    confirmPrompt(ws, prompt, "steer now", 42);
    ws.simulateMessage({
      domain: "session",
      action: "message",
      payload: {
        blocks: [
          {
            type: "stream_event",
            agent_message_id: 43,
            event: {
              type: "content_block_start",
              index: 0,
              content_block: { type: "text", text: "used the steer" },
            },
          },
        ],
      },
    });

    ws.simulateMessage({
      domain: "session",
      action: "ended",
      payload: {
        reason: "turn_complete",
        received_prompt_message_uuids: [messageUuid],
      },
    });

    const blocks = useWsSessionStore.getState().sessions.s1.blocks;
    const userIndex = blocks.findIndex((block) => block.messageDbId === 42);
    const laterAgentIndex = blocks.findIndex((block) => block.id === "msg-43");
    expect(userIndex).toBeGreaterThanOrEqual(0);
    // A delayed terminal receipt changes state in place. Moving the bubble
    // back to its early persistence slot would create the same transcript jump
    // as acknowledging it before the provider replayed it.
    expect(userIndex).toBeGreaterThan(laterAgentIndex);
    expect(blocks[userIndex].promptDeliveryState).toBe("received_agent");
  });

  it("does not replay pending steering prompts when an interrupted turn ends", async () => {
    const ws = await connectInitializedReceiptSession();
    const store = useWsSessionStore.getState();

    store.sendPrompt("s1", "first");
    const first = JSON.parse(ws.sent.at(-1) ?? "{}");
    confirmPrompt(ws, first, "first", 41);
    store.sendPrompt("s1", "second");
    const second = JSON.parse(ws.sent.at(-1) ?? "{}");
    confirmPrompt(ws, second, "second", 42);
    ws.simulateMessage({
      domain: "session",
      action: "prompt_received",
      payload: { message_uuid: first.payload.message_uuid, delivery_state: "received_agent" },
    });
    ws.sent = [];

    store.interrupt("s1");

    const sent = ws.sent.map((raw) => JSON.parse(raw));
    expect(sent.map((envelope) => envelope.action)).toEqual(["interrupt"]);

    ws.simulateMessage({
      domain: "session",
      action: "ended",
      payload: { reason: "turn_complete" },
    });

    const afterEnded = ws.sent.map((raw) => JSON.parse(raw));
    expect(afterEnded.map((envelope) => envelope.action)).toEqual(["interrupt"]);
    expect(
      useWsSessionStore
        .getState()
        .sessions.s1.blocks.find((block) => block.messageUuid === second.payload.message_uuid)
        ?.promptDeliveryState,
    ).toBe("delivery_unknown");
  });
});
