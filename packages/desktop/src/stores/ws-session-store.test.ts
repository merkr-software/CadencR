import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FALLBACK_MODEL_ID } from "../shared/models";
import { useWsSessionStore, applyMutations, createStreamingState } from "./ws-session-store";
import { updateSession } from "./ws-session-types";
import { invalidateWorktreeQueries } from "@/lib/worktreeQueries";
import { forceReconnectAll } from "@/lib/ws-reconnect";

vi.mock("@/lib/worktreeQueries", () => ({
  invalidateWorktreeQueries: vi.fn(),
}));

// --- Mock WebSocket ---

class MockWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSED = 3;
  static instances: MockWebSocket[] = [];

  readyState = MockWebSocket.OPEN;
  sent: string[] = [];
  private listeners: Record<string, Array<(...args: unknown[]) => void>> = {};

  constructor(_url: string) {
    MockWebSocket.instances.push(this);
    Promise.resolve().then(() => this.fireEvent("open"));
  }

  addEventListener(event: string, cb: (...args: unknown[]) => void) {
    (this.listeners[event] ??= []).push(cb);
  }

  removeEventListener() {}

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = MockWebSocket.CLOSED;
  }

  fireEvent(event: string, data?: unknown) {
    for (const cb of this.listeners[event] ?? []) {
      cb(data ?? {});
    }
  }

  simulateMessage(envelope: { domain: string; action: string; ref?: string; payload: unknown }) {
    const raw = JSON.stringify({ id: "srv-1", ...envelope });
    this.fireEvent("message", { data: raw });
  }

  static reset() {
    MockWebSocket.instances = [];
  }
}

Object.assign(MockWebSocket, { OPEN: 1, CONNECTING: 0, CLOSED: 3 });

beforeEach(() => {
  MockWebSocket.reset();
  useWsSessionStore.setState({ sessions: {} });
  vi.stubGlobal("WebSocket", MockWebSocket);
  vi.stubGlobal("window", { ...globalThis.window });
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.mocked(invalidateWorktreeQueries).mockClear();
});

afterEach(() => {
  // Disconnect all sessions to close WebSocket connections and clear pending state
  const store = useWsSessionStore.getState();
  for (const sessionId of Object.keys(store.sessions)) {
    store.disconnect(sessionId);
  }
  for (const id of activeTimerIds) clearTimeout(id);
  activeTimerIds.clear();
  vi.restoreAllMocks();
});

function getWs(): MockWebSocket {
  return MockWebSocket.instances[MockWebSocket.instances.length - 1];
}

function tick(): Promise<void> {
  return new Promise((resolve) => {
    const id = setTimeout(() => {
      activeTimerIds.delete(id);
      resolve();
    }, 10);
    activeTimerIds.add(id);
  });
}

const activeTimerIds = new Set<ReturnType<typeof setTimeout>>();

async function connectInitializedSession(sessionId = "s1"): Promise<{
  store: ReturnType<typeof useWsSessionStore.getState>;
  ws: MockWebSocket;
}> {
  const store = useWsSessionStore.getState();
  store.connect(sessionId);
  await tick();
  const ws = getWs();
  ws.simulateMessage({
    domain: "session",
    action: "initialized",
    payload: { session_id: "srv-1" },
  });
  return { store, ws };
}

function simulatePermissionRequest(ws: MockWebSocket, requestId: string): void {
  ws.simulateMessage({
    domain: "session",
    action: "permission.request",
    payload: {
      request_id: requestId,
      tool_name: "Bash",
      tool_input: { command: "pnpm test" },
      description: "Run tests",
      options: [{ decision: "allow_once", label: "Allow once", description: "Once" }],
    },
  });
}

function simulateQuestionRequest(ws: MockWebSocket, requestId: string): void {
  ws.simulateMessage({
    domain: "session",
    action: "permission.request",
    payload: {
      request_id: requestId,
      tool_name: "AskUserQuestion",
      tool_input: { question: "Which model?", options: ["Sonnet", "Opus"] },
    },
  });
}

describe("ws-session-store", () => {
  it("connect creates a WebSocket and sets isConnected on open", async () => {
    useWsSessionStore.getState().connect("s1");
    await tick();
    const session = useWsSessionStore.getState().sessions["s1"];
    expect(session).toBeDefined();
    expect(session.isConnected).toBe(true);
    expect(MockWebSocket.instances.length).toBe(1);
  });

  it("connect is a no-op if already connected", async () => {
    const store = useWsSessionStore.getState();
    store.connect("s1");
    await tick();
    store.connect("s1");
    store.connect("s1");
    expect(MockWebSocket.instances.length).toBe(1);
  });

  it("connect creates new connection if previous was closed", async () => {
    const store = useWsSessionStore.getState();
    store.connect("s1");
    await tick();
    const ws1 = getWs();
    ws1.readyState = MockWebSocket.CLOSED;
    store.connect("s1");
    await tick();
    expect(MockWebSocket.instances.length).toBe(2);
  });

  it("ignores events from a replaced connection", async () => {
    const { store, ws: staleWs } = await connectInitializedSession();

    staleWs.readyState = MockWebSocket.CLOSED;
    store.connect("s1");
    await tick();
    const currentWs = getWs();
    expect(currentWs).not.toBe(staleWs);

    store.sendPrompt("s1", "hello from mobile");
    const currentSentBeforeStaleEvents = currentWs.sent.length;
    staleWs.fireEvent("open");
    staleWs.simulateMessage({
      domain: "session",
      action: "user_message",
      payload: { text: "hello from mobile" },
    });
    staleWs.fireEvent("error");
    staleWs.fireEvent("close");

    const session = useWsSessionStore.getState().sessions["s1"];
    expect(session.isConnected).toBe(true);
    expect(currentWs.sent).toHaveLength(currentSentBeforeStaleEvents);
    expect(session.blocks.filter((block) => block.type === "user_message")).toHaveLength(1);
  });

  it("disconnect closes the WebSocket and removes the session", async () => {
    const store = useWsSessionStore.getState();
    store.connect("s1");
    await tick();
    const ws = getWs();
    store.disconnect("s1");
    expect(ws.readyState).toBe(MockWebSocket.CLOSED);
    expect(useWsSessionStore.getState().sessions["s1"]).toBeUndefined();
  });

  it("destroy sends destroy envelope and closes connection", async () => {
    const store = useWsSessionStore.getState();
    store.connect("s1");
    await tick();
    const ws = getWs();
    ws.simulateMessage({
      domain: "session",
      action: "initialized",
      payload: { session_id: "srv-1" },
    });
    store.destroy("s1");
    const destroyMsg = JSON.parse(ws.sent[ws.sent.length - 1]);
    expect(destroyMsg.action).toBe("destroy");
    expect(destroyMsg.payload.session_id).toBe("srv-1");
    expect(ws.readyState).toBe(MockWebSocket.CLOSED);
    expect(useWsSessionStore.getState().sessions["s1"].lifecycle).toEqual({
      phase: "terminal",
      reason: "completed",
    });
  });

  it("sendPrompt appends user message block without marking the agent running", async () => {
    const store = useWsSessionStore.getState();
    store.connect("s1");
    await tick();
    const ws = getWs();
    ws.simulateMessage({
      domain: "session",
      action: "initialized",
      payload: { session_id: "srv-1" },
    });
    store.sendPrompt("s1", "hello");
    const session = useWsSessionStore.getState().sessions["s1"];
    expect(session.lifecycle).toEqual({ phase: "idle" });
    expect(session.blocks.length).toBe(1);
    expect(session.blocks[0].type).toBe("user_message");
    expect(session.blocks[0].content).toBe("hello");
  });

  it("sendPrompt includes selected profile in prompt payload", async () => {
    const { store, ws } = await connectInitializedSession();

    store.sendPrompt("s1", "hello", { claudeProfile: "bedrock" });

    const sent = ws.sent.map((raw) => JSON.parse(raw));
    expect(sent.at(-1)).toMatchObject({
      domain: "session",
      action: "prompt.send",
      payload: {
        session_id: "srv-1",
        text: "hello",
        profile: "bedrock",
      },
    });
  });

  it("sendPrompt always carries a user_message_ref and stamps the live block on prompt_persisted", async () => {
    const { store, ws } = await connectInitializedSession();

    store.sendPrompt("s1", "hello");

    const sent = ws.sent.map((raw) => JSON.parse(raw));
    const ref = sent.at(-1).payload.user_message_ref;
    expect(ref).toEqual(expect.any(String));
    const block = useWsSessionStore.getState().sessions["s1"].blocks.at(-1);
    expect(block?.clientMessageId).toBe(ref);
    expect(block?.messageDbId).toBeUndefined();

    // The persisted ack arrives and stamps the DB id (enables rewind/fork).
    ws.simulateMessage({
      domain: "session",
      action: "prompt_persisted",
      payload: { user_message_ref: ref, message_id: 4242 },
    });
    expect(useWsSessionStore.getState().sessions["s1"].blocks.at(-1)?.messageDbId).toBe(4242);
  });

  it("setProfile sends a session-scoped profile.set envelope", async () => {
    const { store, ws } = await connectInitializedSession();

    store.setProfile("s1", "bedrock");

    const sent = ws.sent.map((raw) => JSON.parse(raw));
    expect(sent.at(-1)).toMatchObject({
      domain: "session",
      action: "profile.set",
      payload: {
        session_id: "srv-1",
        profile: "bedrock",
      },
    });
  });

  it("sendPrompt marks mid-turn messages as pending when prompt receipts are supported", async () => {
    const store = useWsSessionStore.getState();
    store.connect("s1");
    await tick();
    const ws = getWs();
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
        blocks: [
          {
            type: "assistant",
            message: { content: [{ type: "text", text: "working" }] },
          },
        ],
      },
    });

    store.sendPrompt("s1", "steer now");

    const sent = JSON.parse(ws.sent[ws.sent.length - 1]);
    const session = useWsSessionStore.getState().sessions["s1"];
    const pending = session.blocks.find((block) => block.type === "user_message");
    expect(sent.payload.client_message_id).toEqual(expect.any(String));
    expect(pending?.clientMessageId).toBe(sent.payload.client_message_id);
    expect(pending?.promptDeliveryState).toBe("pending_agent");
    expect(session.rootBlocks.at(-1)?.id).toBe(pending?.id);
  });

  it("prompt_received clears the pending receipt indicator", async () => {
    const store = useWsSessionStore.getState();
    store.connect("s1");
    await tick();
    const ws = getWs();
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
        blocks: [
          {
            type: "assistant",
            message: { content: [{ type: "text", text: "working" }] },
          },
        ],
      },
    });
    store.sendPrompt("s1", "steer now");
    const sent = JSON.parse(ws.sent[ws.sent.length - 1]);

    ws.simulateMessage({
      domain: "session",
      action: "prompt_received",
      payload: { client_message_id: sent.payload.client_message_id },
    });

    const userBlock = useWsSessionStore
      .getState()
      .sessions["s1"].blocks.find((block) => block.type === "user_message");
    expect(userBlock?.promptDeliveryState).toBe("received_agent");
    expect(userBlock?.clientMessageId).toBeUndefined();
  });

  it("keeps a pending steering prompt after stop and clears it on resumed activity", async () => {
    const store = useWsSessionStore.getState();
    store.connect("s1");
    await tick();
    const ws = getWs();
    ws.simulateMessage({
      domain: "session",
      action: "initialized",
      payload: {
        session_id: "srv-1",
        provider: "claude_code",
        supports_prompt_receipts: true,
      },
    });
    ws.simulateMessage({
      domain: "session",
      action: "message",
      payload: {
        blocks: [
          {
            type: "assistant",
            message: { content: [{ type: "text", text: "working" }] },
          },
        ],
      },
    });

    store.sendPrompt("s1", "steer now");
    const sent = JSON.parse(ws.sent[ws.sent.length - 1]);
    ws.simulateMessage({
      domain: "session",
      action: "message",
      payload: {
        blocks: [
          {
            type: "assistant",
            message: { content: [{ type: "text", text: " still working" }] },
          },
        ],
      },
    });
    ws.simulateMessage({
      domain: "session",
      action: "ended",
      payload: { reason: "turn_complete" },
    });
    ws.simulateMessage({
      domain: "session",
      action: "turn_complete",
      payload: { reason: "turn_complete" },
    });
    store.setPersistedState("s1", {
      blocks: [
        {
          id: "persisted-assistant-1",
          type: "text",
          content: "persisted old turn",
        },
      ],
      lifecycle: { phase: "terminal", reason: "completed" },
    });

    let userBlocks = useWsSessionStore
      .getState()
      .sessions["s1"].blocks.filter((block) => block.type === "user_message");
    let session = useWsSessionStore.getState().sessions["s1"];
    expect(userBlocks).toHaveLength(1);
    expect(userBlocks[0]).toMatchObject({
      content: "steer now",
      promptDeliveryState: "pending_agent",
    });
    expect(session.lifecycle).toEqual({
      phase: "terminal",
      reason: "completed",
    });
    expect(session.blocks.some((block) => block.type === "turn_summary")).toBe(false);

    store.sendPrompt("s1", "resume please");
    ws.simulateMessage({
      domain: "session",
      action: "prompt_received",
      payload: { client_message_id: sent.payload.client_message_id },
    });

    ws.simulateMessage({
      domain: "session",
      action: "message",
      payload: {
        blocks: [
          {
            type: "assistant",
            message: {
              content: [{ type: "text", text: "processing queued prompt" }],
            },
          },
        ],
      },
    });

    session = useWsSessionStore.getState().sessions["s1"];
    userBlocks = session.blocks.filter((block) => block.type === "user_message");
    expect(session.lifecycle).toEqual({ phase: "active" });
    expect(userBlocks).toHaveLength(2);
    expect(userBlocks[0]).toMatchObject({
      content: "steer now",
      promptDeliveryState: "received_agent",
    });
    expect(userBlocks[0].clientMessageId).toBeUndefined();
    expect(userBlocks[1]).toMatchObject({ content: "resume please" });
    expect(userBlocks[1].promptDeliveryState).toBeUndefined();
    expect(session.blocks.some((block) => block.type === "turn_summary")).toBe(false);

    ws.simulateMessage({
      domain: "session",
      action: "ended",
      payload: { reason: "turn_complete" },
    });
    expect(useWsSessionStore.getState().sessions["s1"].lifecycle).toEqual({
      phase: "terminal",
      reason: "completed",
    });
  });

  it("sendPrompt before initialized queues prompt and flushes after initialized", async () => {
    const store = useWsSessionStore.getState();
    store.connect("s1");
    await tick();
    const ws = getWs();

    store.setPermissionMode("s1", "plan");
    store.sendPrompt("s1", "hello");

    expect(ws.sent).toHaveLength(0);
    let session = useWsSessionStore.getState().sessions["s1"];
    expect(session.queuedPrompts).toHaveLength(1);
    expect(session.lifecycle).toEqual({ phase: "idle" });

    ws.simulateMessage({
      domain: "session",
      action: "initialized",
      payload: { session_id: "srv-1" },
    });

    const sent = ws.sent.map((raw) => JSON.parse(raw));
    expect(sent).toHaveLength(2);
    expect(sent[0].action).toBe("mode.set");
    expect(sent[0].payload).toMatchObject({
      session_id: "srv-1",
      mode: "plan",
    });
    expect(sent[1].action).toBe("prompt.send");
    expect(sent[1].payload).toMatchObject({
      session_id: "srv-1",
      text: "hello",
    });

    session = useWsSessionStore.getState().sessions["s1"];
    expect(session.queuedPrompts).toHaveLength(0);
    expect(session.lifecycle).toEqual({ phase: "idle" });
  });

  it("setCodexPermissionMode sends codex access mode to backend and waits for change event", async () => {
    const store = useWsSessionStore.getState();
    store.connect("s1");
    await tick();
    const ws = getWs();
    ws.simulateMessage({
      domain: "session",
      action: "initialized",
      payload: { session_id: "srv-1", provider: "codex_cli" },
    });

    store.setCodexPermissionMode("s1", "autoReview");

    const sent = ws.sent.map((raw) => JSON.parse(raw));
    expect(sent.at(-1)).toMatchObject({
      action: "codex_permission_mode.set",
      payload: { session_id: "srv-1", mode: "autoReview" },
    });
    expect(useWsSessionStore.getState().sessions["s1"].codexPermissionMode).toBe("default");

    ws.simulateMessage({
      domain: "session",
      action: "codex_permission_mode.changed",
      payload: { mode: "autoReview" },
    });
    expect(useWsSessionStore.getState().sessions["s1"].codexPermissionMode).toBe("autoReview");
  });

  it("setPermissionMode before initialized defers mode.set until initialized", async () => {
    const store = useWsSessionStore.getState();
    store.connect("s1");
    await tick();
    const ws = getWs();

    store.setPermissionMode("s1", "plan");
    expect(ws.sent).toHaveLength(0);
    expect(useWsSessionStore.getState().sessions["s1"].permissionMode).toBe("plan");

    ws.simulateMessage({
      domain: "session",
      action: "initialized",
      payload: { session_id: "srv-1" },
    });

    const sent = ws.sent.map((raw) => JSON.parse(raw));
    expect(sent).toHaveLength(1);
    expect(sent[0].action).toBe("mode.set");
    expect(sent[0].payload).toMatchObject({
      session_id: "srv-1",
      mode: "plan",
    });
  });

  // Regression test for the first-prompt permission-mode race: pre-init
  // selections for *non-plan* modes (acceptEdits, default, bypassPermissions,
  // auto) used to be silently dropped because `buildQueuedInitEnvelopes` only
  // replayed `"plan"`. The first prompt would then spawn the CLI in the
  // backend provider default, and the user saw a permission prompt for every
  // edit even though the chip showed "Auto-Accept Edits". Cycling Shift+Tab
  // recovered because `setPermissionMode` post-`serverSessionId` speaks
  // directly to the live CLI.
  it("queued prompts replay the current non-plan mode via mode.set", async () => {
    const store = useWsSessionStore.getState();
    store.connect("s1");
    await tick();
    const ws = getWs();

    store.setPermissionMode("s1", "acceptEdits");
    store.sendPrompt("s1", "hello");
    expect(ws.sent).toHaveLength(0);

    ws.simulateMessage({
      domain: "session",
      action: "initialized",
      payload: { session_id: "srv-1" },
    });

    const sent = ws.sent.map((raw) => JSON.parse(raw));
    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatchObject({
      action: "mode.set",
      payload: { session_id: "srv-1", mode: "acceptEdits" },
    });
    expect(sent[1]).toMatchObject({
      action: "prompt.send",
      payload: { session_id: "srv-1", text: "hello" },
    });
  });

  it("setPersistedState sets blocks and lifecycle", () => {
    // Ensure session exists first
    useWsSessionStore.getState().connect("s1");
    const blocks = [{ id: "b1", type: "text" as const, content: "restored" }];
    useWsSessionStore.getState().setPersistedState("s1", {
      blocks,
      lifecycle: { phase: "terminal", reason: "completed" },
    });
    const session = useWsSessionStore.getState().sessions["s1"];
    expect(session.blocks).toEqual(blocks);
    expect(session.lifecycle).toEqual({
      phase: "terminal",
      reason: "completed",
    });
    expect(session.persistedLoaded).toBe(true);
  });

  it("setPersistedState restores provider, model, and runtime session metadata", () => {
    useWsSessionStore.getState().connect("s1");
    useWsSessionStore.getState().setPersistedState("s1", {
      blocks: [{ id: "b1", type: "text" as const, content: "restored" }],
      lifecycle: { phase: "terminal", reason: "completed" },
      currentProviderId: "opencode",
      currentModelId: "openai/gpt-5.3-codex",
      runtimeProvider: "opencode",
      runtimeSessionId: "ses_live_123",
    });
    const session = useWsSessionStore.getState().sessions["s1"];
    expect(session.currentProviderId).toBe("opencode");
    expect(session.currentModelId).toBe("openai/gpt-5.3-codex");
    expect(session.runtimeProvider).toBe("opencode");
    expect(session.runtimeSessionId).toBe("ses_live_123");
  });

  it("setPersistedState restores the persisted permission mode (sticky bypassPermissions)", () => {
    // Regression: a re-seed (app relaunch, dev HMR reload, reconnect rebuild)
    // must rehydrate the persisted mode rather than keep the createSessionEntry
    // default. Without this, sticky bypassPermissions silently reverts to
    // acceptEdits.
    useWsSessionStore.getState().connect("s1");
    expect(useWsSessionStore.getState().sessions["s1"].permissionMode).toBe("acceptEdits");
    useWsSessionStore.getState().setPersistedState("s1", {
      blocks: [{ id: "b1", type: "text" as const, content: "restored" }],
      lifecycle: { phase: "terminal", reason: "completed" },
      currentProviderId: "claude_code",
      permissionMode: "bypassPermissions",
    });
    expect(useWsSessionStore.getState().sessions["s1"].permissionMode).toBe("bypassPermissions");
  });

  it("setPersistedState leaves the default permission mode untouched when omitted", () => {
    useWsSessionStore.getState().connect("s1");
    useWsSessionStore.getState().setPersistedState("s1", {
      blocks: [{ id: "b1", type: "text" as const, content: "restored" }],
      lifecycle: { phase: "terminal", reason: "completed" },
      currentProviderId: "claude_code",
    });
    expect(useWsSessionStore.getState().sessions["s1"].permissionMode).toBe("acceptEdits");
  });

  it("setPersistedState uses runtimeProvider as currentProviderId when provider field is omitted", () => {
    useWsSessionStore.getState().connect("s1");
    useWsSessionStore.getState().setPersistedState("s1", {
      blocks: [{ id: "b1", type: "text" as const, content: "restored" }],
      lifecycle: { phase: "terminal", reason: "completed" },
      runtimeProvider: "opencode",
      currentModelId: "openai/gpt-5.3-codex",
    });
    const session = useWsSessionStore.getState().sessions["s1"];
    expect(session.currentProviderId).toBe("opencode");
    expect(session.runtimeProvider).toBe("opencode");
  });

  it("runtime_session_id action sets runtimeSessionId on the session", async () => {
    const store = useWsSessionStore.getState();
    store.connect("s1");
    await tick();
    const ws = getWs();
    ws.simulateMessage({
      domain: "session",
      action: "initialized",
      payload: { session_id: "srv-1" },
    });

    ws.simulateMessage({
      domain: "session",
      action: "runtime_session_id",
      payload: { runtime_session_id: "uuid-abc-123" },
    });

    const session = useWsSessionStore.getState().sessions["s1"];
    expect(session.runtimeSessionId).toBe("uuid-abc-123");
  });

  it("runtime_session_id dedup guard skips update when value unchanged", async () => {
    const store = useWsSessionStore.getState();
    store.connect("s1");
    await tick();
    const ws = getWs();
    ws.simulateMessage({
      domain: "session",
      action: "initialized",
      payload: { session_id: "srv-1" },
    });

    ws.simulateMessage({
      domain: "session",
      action: "runtime_session_id",
      payload: { runtime_session_id: "uuid-abc-123" },
    });

    // Capture sessions reference after first set
    const sessionsAfterFirst = useWsSessionStore.getState().sessions;

    // Send the same value again
    ws.simulateMessage({
      domain: "session",
      action: "runtime_session_id",
      payload: { runtime_session_id: "uuid-abc-123" },
    });

    // Sessions object should be the same reference (no update triggered)
    const sessionsAfterSecond = useWsSessionStore.getState().sessions;
    expect(sessionsAfterSecond).toBe(sessionsAfterFirst);
    expect(sessionsAfterSecond["s1"].runtimeSessionId).toBe("uuid-abc-123");
  });

  it("preserves serverSessionId and runtimeSessionId across transient transport drops", async () => {
    const store = useWsSessionStore.getState();
    store.connect("s1");
    await tick();
    const ws = getWs();

    ws.simulateMessage({
      domain: "session",
      action: "initialized",
      payload: { session_id: "srv-1" },
    });
    ws.simulateMessage({
      domain: "session",
      action: "runtime_session_id",
      payload: { runtime_session_id: "uuid-abc-123" },
    });
    expect(useWsSessionStore.getState().sessions["s1"].serverSessionId).toBe("srv-1");

    ws.fireEvent("close");
    const session = useWsSessionStore.getState().sessions["s1"];
    expect(session.isConnected).toBe(false);
    // The WS is just transport; both the DB session id (`serverSessionId`)
    // and the underlying agent runtime session id (`runtimeSessionId`)
    // remain valid on the backend across a transport hiccup. Wiping
    // `serverSessionId` would cause the next user-initiated envelope to
    // ship `session_id: ""`, which the backend rejects as
    // `INVALID_SESSION_ID` (the post-OS-sleep failure mode users hit
    // before this was fixed). The reconnect path re-emits `session.init`
    // to rebuild the per-connection handle on the backend.
    expect(session.serverSessionId).toBe("srv-1");
    expect(session.runtimeSessionId).toBe("uuid-abc-123");
    expect(session.conn).toBeNull();
  });

  it("re-emits session.init on reconnect to rebuild the backend handle", async () => {
    const store = useWsSessionStore.getState();
    store.connect("s1");
    await tick();
    const initialWs = getWs();
    // Initialise the session: backend assigns a serverSessionId, the
    // renderer learns featureId / provider / model.
    store.initSession("s1", {
      cwd: "/tmp/test-worktree",
      featureId: 42,
      provider: "claude-code",
      model: "claude-sonnet-4-5",
    });
    initialWs.simulateMessage({
      domain: "session",
      action: "initialized",
      payload: {
        session_id: "srv-1",
        provider: "claude-code",
        model: "claude-sonnet-4-5",
      },
    });
    expect(useWsSessionStore.getState().sessions["s1"].serverSessionId).toBe("srv-1");

    // Simulate the post-sleep transport drop + the watchdog's force
    // reconnect (instead of waiting for the 1s exponential-backoff
    // timer). The store should fire a fresh session.init carrying the
    // cached config (provider, model, feature_id) so the new socket's
    // backend sdk_sessions map gets rebuilt.
    initialWs.fireEvent("close");
    forceReconnectAll();
    await tick();
    const newWs = getWs();
    expect(newWs).not.toBe(initialWs);
    const reinitEnvelopes = newWs.sent
      .map((raw) => JSON.parse(raw))
      .filter((env) => env.domain === "session" && env.action === "init");
    expect(reinitEnvelopes).toHaveLength(1);
    expect(reinitEnvelopes[0].payload).toMatchObject({
      feature_id: 42,
      cwd: "/tmp/test-worktree",
      provider: "claude-code",
      model: "claude-sonnet-4-5",
    });
  });

  it("sends gate.close and clears pending gates only after the backend confirms", async () => {
    const store = useWsSessionStore.getState();
    store.connect("s1");
    await tick();
    const ws = getWs();
    ws.simulateMessage({
      domain: "session",
      action: "initialized",
      payload: { session_id: "srv-1" },
    });
    ws.simulateMessage({
      domain: "session",
      action: "permission.request",
      payload: {
        request_id: "perm-1",
        tool_name: "Bash",
        tool_input: { command: "pnpm test" },
        description: "Run tests",
        options: [
          {
            decision: "allow_once",
            label: "Allow once",
            description: "Approve once",
          },
          {
            decision: "deny",
            label: "Deny",
            description: "Reject",
          },
        ],
      },
    });

    expect(useWsSessionStore.getState().sessions["s1"].pendingPermission?.requestId).toBe("perm-1");

    store.closeGate("s1", "escape");

    const closeEnvelope = JSON.parse(ws.sent[ws.sent.length - 1]);
    expect(closeEnvelope.domain).toBe("session");
    expect(closeEnvelope.action).toBe("gate.close");
    expect(closeEnvelope.payload).toMatchObject({
      session_id: "srv-1",
      request_id: "perm-1",
      reason: "escape",
    });
    expect(useWsSessionStore.getState().sessions["s1"].pendingPermission).not.toBeNull();

    ws.simulateMessage({
      domain: "session",
      action: "gate.closed",
      payload: { session_id: "srv-1", request_id: "perm-1", reason: "escape" },
    });

    const session = useWsSessionStore.getState().sessions["s1"];
    expect(session.pendingPermission).toBeNull();
    expect(session.pendingPermissionQueue).toEqual([]);
    expect(session.pendingRequestId).toBe("");
    expect(session.pendingQuestions).toEqual([]);
    expect(session.pendingPlanApproval).toBeNull();
    expect(session.lifecycle).toEqual({ phase: "terminal", reason: "denied" });
  });

  it("drops stale gate state when the backend reports SESSION_NOT_FOUND", async () => {
    const { ws } = await connectInitializedSession();
    simulatePermissionRequest(ws, "perm-1");
    expect(useWsSessionStore.getState().sessions["s1"].pendingPermission?.requestId).toBe("perm-1");

    // Backend asynchronously reports the session is gone (e.g. CLI died,
    // sdk_sessions handle dropped). The gate must disappear so the user
    // can move on instead of clicking buttons that bounce.
    ws.simulateMessage({
      domain: "session",
      action: "error",
      payload: { code: "SESSION_NOT_FOUND", message: "Session not found" },
    });

    const session = useWsSessionStore.getState().sessions["s1"];
    expect(session.pendingPermission).toBeNull();
    expect(session.pendingPermissionQueue).toEqual([]);
    expect(session.pendingRequestId).toBe("");
    expect(session.pendingQuestions).toEqual([]);
    expect(session.pendingPlanApproval).toBeNull();
    // Error block surfaces the reason so the user understands the dismissal.
    expect(session.blocks.at(-1)).toMatchObject({
      type: "error",
      content: "Session not found",
    });
  });

  it("drops the pending question when an INVALID_STATE error arrives", async () => {
    const { ws } = await connectInitializedSession();
    simulateQuestionRequest(ws, "q-1");
    expect(useWsSessionStore.getState().sessions["s1"].pendingQuestions).toHaveLength(1);

    ws.simulateMessage({
      domain: "session",
      action: "error",
      payload: { code: "INVALID_STATE", message: "Session not active" },
    });

    const session = useWsSessionStore.getState().sessions["s1"];
    expect(session.pendingQuestions).toEqual([]);
    expect(session.pendingRequestId).toBe("");
  });

  it("preserves the gate when an unrelated error (DB_ERROR) arrives", async () => {
    const { ws } = await connectInitializedSession();
    simulatePermissionRequest(ws, "perm-keep");
    ws.simulateMessage({
      domain: "session",
      action: "error",
      payload: { code: "DB_ERROR", message: "Disk full" },
    });

    // DB errors don't mean the gate is unanswerable — keep the user's UI.
    const session = useWsSessionStore.getState().sessions["s1"];
    expect(session.pendingPermission?.requestId).toBe("perm-keep");
  });

  it("clears the gate when respondToPermission reply is a session-dead error", async () => {
    const { store, ws } = await connectInitializedSession();
    simulatePermissionRequest(ws, "perm-dead");

    store.respondToPermission("s1", "perm-dead", "allow_once");
    const respondEnvelope = JSON.parse(ws.sent[ws.sent.length - 1]);
    expect(respondEnvelope.action).toBe("permission.respond");
    expect(useWsSessionStore.getState().sessions["s1"].submittingPermissionRequestId).toBe(
      "perm-dead",
    );

    // Backend replies to that envelope (matched by ref) with INVALID_STATE.
    // Because `sendRequest` intercepts the reply, `handleError` isn't
    // invoked — `respondToPermission` must clear the gate itself.
    ws.simulateMessage({
      domain: "session",
      action: "error",
      ref: respondEnvelope.id,
      payload: { code: "INVALID_STATE", message: "Session not yet active" },
    });
    await tick();

    const session = useWsSessionStore.getState().sessions["s1"];
    expect(session.pendingPermission).toBeNull();
    expect(session.pendingPermissionQueue).toEqual([]);
    expect(session.pendingRequestId).toBe("");
    expect(session.submittingPermissionRequestId).toBeNull();
    expect(session.lifecycle).toEqual({
      phase: "error",
      message: "Session not yet active",
    });
    expect(session.blocks.at(-1)).toMatchObject({
      type: "error",
      content: "Session not yet active",
    });
  });

  it("keeps the gate on respondToPermission timeout so a reconnect can retry", async () => {
    const { store, ws } = await connectInitializedSession();
    simulatePermissionRequest(ws, "perm-retry");

    store.respondToPermission("s1", "perm-retry", "allow_once");
    const respondEnvelope = JSON.parse(ws.sent[ws.sent.length - 1]);
    // Simulate the WS-level null payload that `sendRequest` resolves with on
    // timeout — the gate stays so the user can retry once the WS recovers.
    const session = useWsSessionStore.getState().sessions["s1"];
    const cb = session.pendingWsRequests.get(respondEnvelope.id);
    cb?.(null);
    await tick();

    const after = useWsSessionStore.getState().sessions["s1"];
    expect(after.pendingPermission?.requestId).toBe("perm-retry");
    expect(after.submittingPermissionRequestId).toBeNull();
  });

  it("new session defaults currentModelId to FALLBACK_MODEL_ID", async () => {
    useWsSessionStore.getState().connect("s1");
    await tick();
    const session = useWsSessionStore.getState().sessions["s1"];
    expect(session.currentModelId).toBe(FALLBACK_MODEL_ID);
  });

  it("initSession with model updates currentModelId in store", async () => {
    const store = useWsSessionStore.getState();
    store.connect("s1");
    await tick();
    store.initSession("s1", { model: "claude-haiku-4-5-20251001" });
    const session = useWsSessionStore.getState().sessions["s1"];
    expect(session.currentModelId).toBe("claude-haiku-4-5-20251001");
  });

  it("initSession without model keeps FALLBACK_MODEL_ID", async () => {
    const store = useWsSessionStore.getState();
    store.connect("s1");
    await tick();
    store.initSession("s1", { cwd: "/tmp" });
    const session = useWsSessionStore.getState().sessions["s1"];
    expect(session.currentModelId).toBe(FALLBACK_MODEL_ID);
  });

  it("session.initialized with model updates currentModelId from server", async () => {
    const store = useWsSessionStore.getState();
    store.connect("s1");
    await tick();
    // Frontend sends settings model on init
    store.initSession("s1", { model: "opus[1m]" });
    expect(useWsSessionStore.getState().sessions["s1"].currentModelId).toBe("opus[1m]");

    // Server responds with the stored model from the DB (last used)
    const ws = MockWebSocket.instances[0];
    ws.simulateMessage({
      domain: "session",
      action: "initialized",
      payload: { session_id: "42", model: "claude-haiku-4-5-20251001" },
    });
    expect(useWsSessionStore.getState().sessions["s1"].currentModelId).toBe(
      "claude-haiku-4-5-20251001",
    );
  });

  it("session.initialized without model keeps frontend model", async () => {
    const store = useWsSessionStore.getState();
    store.connect("s1");
    await tick();
    store.initSession("s1", { model: "opus[1m]" });

    const ws = MockWebSocket.instances[0];
    ws.simulateMessage({
      domain: "session",
      action: "initialized",
      payload: { session_id: "42" },
    });
    expect(useWsSessionStore.getState().sessions["s1"].currentModelId).toBe("opus[1m]");
  });

  it("session.initialized with codex permission mode updates the stored access chip", async () => {
    const store = useWsSessionStore.getState();
    store.connect("s1");
    await tick();

    const ws = getWs();
    ws.simulateMessage({
      domain: "session",
      action: "initialized",
      payload: {
        session_id: "42",
        provider: "codex_cli",
        codex_permission_mode: "fullAccess",
      },
    });

    const session = useWsSessionStore.getState().sessions["s1"];
    expect(session.codexPermissionMode).toBe("fullAccess");
  });

  it("session.initialized with profile updates the stored session profile", async () => {
    const store = useWsSessionStore.getState();
    store.connect("s1");
    await tick();

    getWs().simulateMessage({
      domain: "session",
      action: "initialized",
      payload: {
        session_id: "42",
        provider: "claude_code",
        model: "claude-sonnet-4-5",
        profile: "bedrock",
      },
    });

    const session = useWsSessionStore.getState().sessions["s1"];
    expect(session.currentProviderId).toBe("claude_code");
    expect(session.currentModelId).toBe("claude-sonnet-4-5");
    expect(session.currentProfile).toBe("bedrock");
  });

  it("session.profile.changed updates profile without changing provider or model", async () => {
    const store = useWsSessionStore.getState();
    store.connect("s1");
    await tick();
    getWs().simulateMessage({
      domain: "session",
      action: "initialized",
      payload: {
        session_id: "42",
        provider: "claude_code",
        model: "claude-sonnet-4-5",
        profile: "default",
      },
    });

    getWs().simulateMessage({
      domain: "session",
      action: "profile.changed",
      payload: {
        provider: "claude_code",
        model: "claude-opus-4-5",
        profile: "bedrock",
      },
    });

    const session = useWsSessionStore.getState().sessions["s1"];
    expect(session.currentProviderId).toBe("claude_code");
    expect(session.currentModelId).toBe("claude-sonnet-4-5");
    expect(session.currentProfile).toBe("bedrock");
  });

  it("session.codex_permission_mode.changed updates the stored access chip", async () => {
    const store = useWsSessionStore.getState();
    store.connect("s1");
    await tick();

    const ws = getWs();
    ws.simulateMessage({
      domain: "session",
      action: "codex_permission_mode.changed",
      payload: { mode: "autoReview" },
    });

    const session = useWsSessionStore.getState().sessions["s1"];
    expect(session.codexPermissionMode).toBe("autoReview");
  });

  it("session.mode.changed accepts Claude bypass as a provider permission mode", async () => {
    const store = useWsSessionStore.getState();
    store.connect("s1");
    await tick();

    const ws = getWs();
    ws.simulateMessage({
      domain: "session",
      action: "initialized",
      payload: { session_id: "42", provider: "claude_code" },
    });
    ws.simulateMessage({
      domain: "session",
      action: "mode.changed",
      payload: { mode: "bypassPermissions" },
    });

    const session = useWsSessionStore.getState().sessions["s1"];
    expect(session.permissionMode).toBe("bypassPermissions");
  });

  it("session.initialized with provider updates current and runtime provider", async () => {
    const store = useWsSessionStore.getState();
    store.connect("s1");
    await tick();
    store.initSession("s1", { provider: "claude_code", model: "opus[1m]" });

    const ws = getWs();
    ws.simulateMessage({
      domain: "session",
      action: "initialized",
      payload: {
        session_id: "42",
        provider: "opencode",
        model: "openai/gpt-5.3-codex",
      },
    });

    const session = useWsSessionStore.getState().sessions["s1"];
    expect(session.currentProviderId).toBe("opencode");
    expect(session.runtimeProvider).toBe("opencode");
    expect(session.currentModelId).toBe("openai/gpt-5.3-codex");
  });

  it("setProvider waits for provider.set.ok before mutating local state", async () => {
    const store = useWsSessionStore.getState();
    store.connect("s1");
    await tick();
    const ws = getWs();
    ws.simulateMessage({
      domain: "session",
      action: "initialized",
      payload: { session_id: "srv-1" },
    });

    useWsSessionStore.setState((state) =>
      updateSession(state, "s1", { currentProviderId: "stale-provider" }),
    );
    store.setProvider("s1", "claude_code");
    expect(useWsSessionStore.getState().sessions["s1"].currentProviderId).toBe("stale-provider");

    ws.simulateMessage({
      domain: "session",
      action: "provider.set.ok",
      payload: { provider: "claude_code" },
    });
    expect(useWsSessionStore.getState().sessions["s1"].currentProviderId).toBe("claude_code");
  });

  it("setModel waits for model.set.ok before mutating local state", async () => {
    const store = useWsSessionStore.getState();
    store.connect("s1");
    await tick();
    const ws = getWs();
    ws.simulateMessage({
      domain: "session",
      action: "initialized",
      payload: { session_id: "srv-1" },
    });

    useWsSessionStore.setState((state) =>
      updateSession(state, "s1", { currentModelId: "opus[1m]" }),
    );
    store.setModel("s1", "haiku");
    expect(useWsSessionStore.getState().sessions["s1"].currentModelId).toBe("opus[1m]");

    ws.simulateMessage({
      domain: "session",
      action: "model.set.ok",
      payload: { model: "haiku" },
    });
    expect(useWsSessionStore.getState().sessions["s1"].currentModelId).toBe("haiku");
  });

  it("model.set.ok preserves tokens and keeps existing context window when backend omits it", async () => {
    const store = useWsSessionStore.getState();
    store.connect("s1");
    await tick();
    const ws = getWs();
    ws.simulateMessage({
      domain: "session",
      action: "initialized",
      payload: { session_id: "srv-1" },
    });
    useWsSessionStore.setState((state) =>
      updateSession(state, "s1", {
        currentModelId: "opus",
        contextUsage: {
          inputTokens: 12345,
          outputTokens: 6789,
          contextWindow: 200000,
          wasCompacted: false,
        },
      }),
    );

    ws.simulateMessage({
      domain: "session",
      action: "model.set.ok",
      payload: { model: "sonnet" },
    });

    const usage = useWsSessionStore.getState().sessions["s1"].contextUsage;
    expect(useWsSessionStore.getState().sessions["s1"].currentModelId).toBe("sonnet");
    expect(usage?.inputTokens).toBe(12345);
    expect(usage?.outputTokens).toBe(6789);
    // Backend did not seed a new window — keep the previous model's window
    // so the bar stays visible until the next authoritative event.
    expect(usage?.contextWindow).toBe(200000);
  });

  it("model.set.ok applies a seeded context window without resetting tokens", async () => {
    const store = useWsSessionStore.getState();
    store.connect("s1");
    await tick();
    const ws = getWs();
    ws.simulateMessage({
      domain: "session",
      action: "initialized",
      payload: { session_id: "srv-1" },
    });
    useWsSessionStore.setState((state) =>
      updateSession(state, "s1", {
        currentModelId: "opus",
        contextUsage: {
          inputTokens: 1000,
          outputTokens: 200,
          contextWindow: 200000,
          wasCompacted: false,
        },
      }),
    );

    ws.simulateMessage({
      domain: "session",
      action: "model.set.ok",
      payload: { model: "claude-opus-4-7[1m]", context_window: 1_000_000 },
    });

    const usage = useWsSessionStore.getState().sessions["s1"].contextUsage;
    expect(usage?.inputTokens).toBe(1000);
    expect(usage?.outputTokens).toBe(200);
    expect(usage?.contextWindow).toBe(1_000_000);
  });

  it("clears optimistic thinking effort when initialized payload omits it", async () => {
    const store = useWsSessionStore.getState();
    store.connect("s1");
    await tick();

    store.initSession("s1", {
      cwd: "/tmp/worktree",
      featureId: 1,
      provider: "opencode",
      model: "openai/gpt-5.4",
      thinkingEffort: "high",
    });

    expect(useWsSessionStore.getState().sessions["s1"].currentThinkingEffort).toBe("high");

    const ws = getWs();
    ws.simulateMessage({
      domain: "session",
      action: "initialized",
      payload: {
        session_id: "srv-1",
        provider: "opencode",
        model: "openai/gpt-5.4",
      },
    });

    expect(useWsSessionStore.getState().sessions["s1"].currentThinkingEffort).toBeUndefined();
  });

  it("sets hasFileChanges when Write tool_call block is received", async () => {
    const store = useWsSessionStore.getState();
    store.connect("s1");
    await tick();
    const ws = getWs();
    ws.simulateMessage({
      domain: "session",
      action: "initialized",
      payload: { session_id: "srv-1" },
    });

    expect(useWsSessionStore.getState().sessions["s1"].hasFileChanges).toBe(false);

    // Simulate an assistant message with a Write tool_use block
    ws.simulateMessage({
      domain: "session",
      action: "message",
      payload: {
        blocks: [
          {
            type: "assistant",
            message: {
              content: [
                {
                  type: "tool_use",
                  id: "tu-1",
                  name: "Write",
                  input: { file_path: "/tmp/test.ts", content: "hello" },
                },
              ],
            },
          },
        ],
      },
    });

    expect(useWsSessionStore.getState().sessions["s1"].hasFileChanges).toBe(true);
  });

  it("sets hasFileChanges for Edit and NotebookEdit tools", async () => {
    const store = useWsSessionStore.getState();
    store.connect("s1");
    await tick();
    const ws = getWs();
    ws.simulateMessage({
      domain: "session",
      action: "initialized",
      payload: { session_id: "srv-1" },
    });

    ws.simulateMessage({
      domain: "session",
      action: "message",
      payload: {
        blocks: [
          {
            type: "assistant",
            message: {
              content: [
                {
                  type: "tool_use",
                  id: "tu-2",
                  name: "Edit",
                  input: { file_path: "/tmp/test.ts" },
                },
              ],
            },
          },
        ],
      },
    });

    expect(useWsSessionStore.getState().sessions["s1"].hasFileChanges).toBe(true);
  });

  it("does not set hasFileChanges for non-file-changing tools", async () => {
    const store = useWsSessionStore.getState();
    store.connect("s1");
    await tick();
    const ws = getWs();
    ws.simulateMessage({
      domain: "session",
      action: "initialized",
      payload: { session_id: "srv-1" },
    });

    ws.simulateMessage({
      domain: "session",
      action: "message",
      payload: {
        blocks: [
          {
            type: "assistant",
            message: {
              content: [
                {
                  type: "tool_use",
                  id: "tu-3",
                  name: "Read",
                  input: { file_path: "/tmp/test.ts" },
                },
              ],
            },
          },
        ],
      },
    });

    expect(useWsSessionStore.getState().sessions["s1"].hasFileChanges).toBe(false);
  });

  it("resets hasFileChanges on cleared action", async () => {
    const store = useWsSessionStore.getState();
    store.connect("s1");
    await tick();
    const ws = getWs();
    ws.simulateMessage({
      domain: "session",
      action: "initialized",
      payload: { session_id: "srv-1" },
    });

    // Set hasFileChanges via a Write tool
    ws.simulateMessage({
      domain: "session",
      action: "message",
      payload: {
        blocks: [
          {
            type: "assistant",
            message: {
              content: [
                {
                  type: "tool_use",
                  id: "tu-4",
                  name: "Write",
                  input: { file_path: "/tmp/test.ts", content: "x" },
                },
              ],
            },
          },
        ],
      },
    });
    expect(useWsSessionStore.getState().sessions["s1"].hasFileChanges).toBe(true);

    // Clear session
    ws.simulateMessage({ domain: "session", action: "cleared", payload: {} });
    expect(useWsSessionStore.getState().sessions["s1"].hasFileChanges).toBe(false);
  });

  it("cleared action preserves existing blocks and appends clear_divider", async () => {
    const store = useWsSessionStore.getState();
    store.connect("s1");
    await tick();
    const ws = getWs();
    ws.simulateMessage({
      domain: "session",
      action: "initialized",
      payload: { session_id: "srv-1" },
    });

    // Add a message block
    ws.simulateMessage({
      domain: "session",
      action: "message",
      payload: {
        blocks: [
          {
            type: "assistant",
            message: { content: [{ type: "text", text: "hello" }] },
          },
        ],
      },
    });
    const blocksBefore = useWsSessionStore.getState().sessions["s1"].blocks;
    expect(blocksBefore.length).toBeGreaterThan(0);

    // Clear with previous_session_id
    ws.simulateMessage({
      domain: "session",
      action: "cleared",
      payload: { previous_session_id: "cli-sess-xyz" },
    });
    const session = useWsSessionStore.getState().sessions["s1"];
    // Blocks preserved + clear_divider appended
    expect(session.blocks.length).toBe(blocksBefore.length + 1);
    const lastBlock = session.blocks[session.blocks.length - 1];
    expect(lastBlock.type).toBe("clear_divider");
    expect(lastBlock.content).toBe("cli-sess-xyz");
    // runtimeSessionId reset
    expect(session.runtimeSessionId).toBe("");
    expect(session.lifecycle).toEqual({ phase: "idle" });
  });

  it("extracts todos from TodoWrite tool_call in assistant message", async () => {
    const store = useWsSessionStore.getState();
    store.connect("s1");
    await tick();
    const ws = getWs();
    ws.simulateMessage({
      domain: "session",
      action: "initialized",
      payload: { session_id: "srv-1" },
    });

    ws.simulateMessage({
      domain: "session",
      action: "message",
      payload: {
        blocks: [
          {
            type: "assistant",
            message: {
              content: [
                {
                  type: "tool_use",
                  id: "tu-todo-1",
                  name: "TodoWrite",
                  input: {
                    todos: [
                      {
                        content: "Write tests",
                        status: "in_progress",
                        activeForm: "Writing tests",
                      },
                      {
                        content: "Deploy",
                        status: "pending",
                        activeForm: "Deploy app",
                      },
                    ],
                  },
                },
              ],
            },
          },
        ],
      },
    });

    const session = useWsSessionStore.getState().sessions["s1"];
    expect(session.todos).toEqual([
      {
        content: "Write tests",
        status: "in_progress",
        activeForm: "Writing tests",
      },
      { content: "Deploy", status: "pending", activeForm: "Deploy app" },
    ]);
  });

  it("extracts todos from streamed TodoWrite (content_block_start + deltas + assistant replace)", async () => {
    const store = useWsSessionStore.getState();
    store.connect("s1");
    await tick();
    const ws = getWs();
    ws.simulateMessage({
      domain: "session",
      action: "initialized",
      payload: { session_id: "srv-1" },
    });

    // 1. content_block_start — creates tool_call with empty args
    ws.simulateMessage({
      domain: "session",
      action: "message",
      payload: {
        blocks: [
          {
            type: "event",
            event: {
              type: "content_block_start",
              index: 0,
              content_block: {
                type: "tool_use",
                id: "tu-stream-1",
                name: "TodoWrite",
              },
            },
          },
        ],
      },
    });

    // 2. content_block_delta — partial JSON
    ws.simulateMessage({
      domain: "session",
      action: "message",
      payload: {
        blocks: [
          {
            type: "event",
            event: {
              type: "content_block_delta",
              index: 0,
              delta: {
                type: "input_json_delta",
                partial_json: '{"todos":[{"content":"Task 1","status":"comple',
              },
            },
          },
        ],
      },
    });

    // Partial JSON shouldn't produce todos yet
    expect(useWsSessionStore.getState().sessions["s1"].todos).toEqual([]);

    // 3. assistant message with complete input — replace action (no toolName in mutation)
    ws.simulateMessage({
      domain: "session",
      action: "message",
      payload: {
        blocks: [
          {
            type: "assistant",
            message: {
              content: [
                {
                  type: "tool_use",
                  id: "tu-stream-1",
                  name: "TodoWrite",
                  input: {
                    todos: [
                      {
                        content: "Task 1",
                        status: "completed",
                        activeForm: "Done",
                      },
                    ],
                  },
                },
              ],
            },
          },
        ],
      },
    });

    const session = useWsSessionStore.getState().sessions["s1"];
    expect(session.todos).toEqual([{ content: "Task 1", status: "completed", activeForm: "Done" }]);
  });

  it("extracts todos from streamed TodoWrite initial input", async () => {
    const store = useWsSessionStore.getState();
    store.connect("s1");
    await tick();
    const ws = getWs();
    ws.simulateMessage({
      domain: "session",
      action: "initialized",
      payload: { session_id: "srv-1" },
    });

    ws.simulateMessage({
      domain: "session",
      action: "message",
      payload: {
        blocks: [
          {
            type: "stream_event",
            session_id: "s1",
            event: {
              type: "content_block_start",
              index: 0,
              content_block: {
                type: "tool_use",
                id: "tu-todo-initial",
                name: "TodoWrite",
                input: {
                  todos: [
                    {
                      content: "Créer une todo de test",
                      status: "in_progress",
                      activeForm: "Créer une todo de test",
                    },
                  ],
                },
              },
            },
          },
        ],
      },
    });

    const session = useWsSessionStore.getState().sessions["s1"];
    expect(session.todos).toEqual([
      {
        content: "Créer une todo de test",
        status: "in_progress",
        activeForm: "Créer une todo de test",
      },
    ]);
  });

  it("setPersistedState extracts todos from restored blocks", () => {
    useWsSessionStore.getState().connect("s1");
    const blocks = [
      { id: "b1", type: "text" as const, content: "hello" },
      {
        id: "b2",
        type: "tool_call" as const,
        content: JSON.stringify({
          todos: [
            {
              content: "Restored task",
              status: "pending",
              activeForm: "Restoring",
            },
          ],
        }),
        toolName: "TodoWrite",
        toolArgs: JSON.stringify({
          todos: [
            {
              content: "Restored task",
              status: "pending",
              activeForm: "Restoring",
            },
          ],
        }),
      },
      { id: "b3", type: "text" as const, content: "done" },
    ];
    useWsSessionStore.getState().setPersistedState("s1", {
      blocks,
      lifecycle: { phase: "terminal", reason: "completed" },
    });
    const session = useWsSessionStore.getState().sessions["s1"];
    expect(session.todos).toEqual([
      { content: "Restored task", status: "pending", activeForm: "Restoring" },
    ]);
  });

  it("setPersistedState extracts todos from child blocks", () => {
    useWsSessionStore.getState().connect("s1");
    const blocks = [
      {
        id: "b1",
        type: "tool_call" as const,
        content: "{}",
        toolName: "Agent",
        childBlocks: [
          {
            id: "b2",
            type: "tool_call" as const,
            content: JSON.stringify({
              todos: [
                {
                  content: "Child task",
                  status: "completed",
                  activeForm: "Done",
                },
              ],
            }),
            toolName: "TodoWrite",
            toolArgs: JSON.stringify({
              todos: [
                {
                  content: "Child task",
                  status: "completed",
                  activeForm: "Done",
                },
              ],
            }),
          },
        ],
      },
    ];
    useWsSessionStore.getState().setPersistedState("s1", {
      blocks,
      lifecycle: { phase: "terminal", reason: "completed" },
    });
    const session = useWsSessionStore.getState().sessions["s1"];
    expect(session.todos).toEqual([
      { content: "Child task", status: "completed", activeForm: "Done" },
    ]);
  });

  it("setPersistedState without TodoWrite blocks leaves todos empty", () => {
    useWsSessionStore.getState().connect("s1");
    const blocks = [{ id: "b1", type: "text" as const, content: "no todos here" }];
    useWsSessionStore.getState().setPersistedState("s1", {
      blocks,
      lifecycle: { phase: "terminal", reason: "completed" },
    });
    const session = useWsSessionStore.getState().sessions["s1"];
    expect(session.todos).toEqual([]);
  });

  it("setPersistedState does not overwrite existing streaming blocks", () => {
    useWsSessionStore.getState().connect("s1");
    // Simulate streaming blocks already present
    const store = useWsSessionStore.getState();
    store.sessions["s1"] = {
      ...store.sessions["s1"],
      blocks: [{ id: "live-1", type: "text" as never, content: "streaming" }],
    };

    // Now call setPersistedState with different blocks (stale DB data)
    useWsSessionStore.getState().setPersistedState("s1", {
      blocks: [{ id: "db-1", type: "text" as const, content: "stale" }],
      lifecycle: { phase: "terminal", reason: "completed" },
    });
    const session = useWsSessionStore.getState().sessions["s1"];
    // Should keep the streaming blocks, not replace with stale DB blocks
    expect(session.blocks[0].id).toBe("live-1");
    expect(session.persistedLoaded).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // setPersistedState — hydration of pending permission / question gates.
  //
  // Regression target: opening a conversation while the agent was paused on a
  // permission or AskUserQuestion request used to drop those fields on the
  // floor — the sidebar (which reads the same DB columns via the unified
  // agents endpoint) showed an indicator while the conversation rendered
  // blank.
  // ---------------------------------------------------------------------------

  describe("setPersistedState pending-gate hydration", () => {
    const bashPermissionSnapshot = {
      request_id: "bd2613bf-a8e6-47d6-9929-22d71083d707",
      tool_name: "Bash",
      tool_input: { command: "find . -name '*.rs'" },
      description: "The provider requests permission to use Bash",
      pattern: null,
      preview: "find . -name '*.rs'",
      options: [
        {
          decision: "allow_once",
          option_id: null,
          label: "Allow once",
          description: "Approve this tool call only",
          collect_feedback: false,
        },
        {
          decision: "deny",
          option_id: null,
          label: "Deny",
          description: "Reject this tool call",
          collect_feedback: true,
        },
      ],
    };

    const askUserQuestionSnapshot = {
      request_id: "q-7",
      tool_name: "AskUserQuestion",
      tool_input: {
        questions: [
          {
            question: "Which strategy do you want?",
            header: "Strategy",
            multiSelect: false,
            options: [
              { label: "Option A", description: "Pick A" },
              { label: "Option B", description: "Pick B" },
            ],
          },
        ],
      },
    };

    it("hydrates pendingPermission and lifecycle from agent-state snapshot", () => {
      useWsSessionStore.getState().connect("s1");
      useWsSessionStore.getState().setPersistedState("s1", {
        blocks: [],
        lifecycle: { phase: "idle" },
        pendingPermission: bashPermissionSnapshot,
      });
      const session = useWsSessionStore.getState().sessions["s1"];
      expect(session.pendingPermission?.toolName).toBe("Bash");
      expect(session.pendingPermission?.requestId).toBe(bashPermissionSnapshot.request_id);
      expect(session.pendingPermissionQueue).toHaveLength(0);
      expect(session.pendingRequestId).toBe(bashPermissionSnapshot.request_id);
      expect(session.lifecycle).toEqual({
        phase: "paused",
        reason: "permission",
      });
      // Snake-case wire fields must be remapped to the frontend's camelCase shape.
      expect(session.pendingPermission?.options?.[0]).toMatchObject({
        decision: "allow_once",
        collectFeedback: false,
      });
    });

    it("hydrates pendingQuestions and lifecycle from agent-state snapshot", () => {
      useWsSessionStore.getState().connect("s1");
      useWsSessionStore.getState().setPersistedState("s1", {
        blocks: [],
        lifecycle: { phase: "idle" },
        pendingQuestions: askUserQuestionSnapshot,
      });
      const session = useWsSessionStore.getState().sessions["s1"];
      expect(session.pendingQuestions).toHaveLength(1);
      expect(session.pendingQuestions[0].question).toBe("Which strategy do you want?");
      expect(session.pendingQuestionToolInput).toEqual(askUserQuestionSnapshot.tool_input);
      expect(session.pendingRequestId).toBe("q-7");
      expect(session.lifecycle).toEqual({
        phase: "paused",
        reason: "question",
      });
    });

    it("hydrates pendingPermission even when restored blocks already exist", () => {
      const store = useWsSessionStore.getState();
      store.connect("s1");
      // Simulate the existing-blocks branch in applyPersistedState (the
      // hydration helper short-circuits to a meta-only patch when blocks
      // are already in the store).
      useWsSessionStore.setState(
        updateSession(useWsSessionStore.getState(), "s1", {
          blocks: [{ id: "live-1", type: "text" as const, content: "live block" }],
        }),
      );
      store.setPersistedState("s1", {
        blocks: [{ id: "db-1", type: "text" as const, content: "stale" }],
        lifecycle: { phase: "idle" },
        pendingPermission: bashPermissionSnapshot,
      });
      const session = useWsSessionStore.getState().sessions["s1"];
      expect(session.pendingPermission?.requestId).toBe(bashPermissionSnapshot.request_id);
      expect(session.pendingRequestId).toBe(bashPermissionSnapshot.request_id);
      expect(session.lifecycle).toEqual({
        phase: "paused",
        reason: "permission",
      });
      // Live blocks survive the hydration.
      expect(session.blocks[0].id).toBe("live-1");
    });

    it("does not clobber a live pending request that beat the snapshot", () => {
      const store = useWsSessionStore.getState();
      store.connect("s1");
      // Pretend a live permission.request envelope already populated state.
      useWsSessionStore.setState(
        updateSession(useWsSessionStore.getState(), "s1", {
          pendingRequestId: "live-X",
        }),
      );
      store.setPersistedState("s1", {
        blocks: [],
        lifecycle: { phase: "idle" },
        pendingPermission: bashPermissionSnapshot,
      });
      const session = useWsSessionStore.getState().sessions["s1"];
      // Race guard: live state wins, snapshot is dropped.
      expect(session.pendingRequestId).toBe("live-X");
      expect(session.pendingPermission).toBeNull();
    });

    it("ignores ExitPlanMode payloads stored in pending_permission (plan branch owns those)", () => {
      useWsSessionStore.getState().connect("s1");
      useWsSessionStore.getState().setPersistedState("s1", {
        blocks: [],
        lifecycle: { phase: "idle" },
        pendingPermission: {
          request_id: "exit-plan-1",
          tool_name: "ExitPlanMode",
          tool_input: { plan: "## Plan" },
        },
      });
      const session = useWsSessionStore.getState().sessions["s1"];
      expect(session.pendingPermission).toBeNull();
      expect(session.pendingRequestId).toBe("");
    });
  });

  it("handles concurrent sessions independently", async () => {
    const store = useWsSessionStore.getState();
    store.connect("a");
    store.connect("b");
    await tick();
    expect(MockWebSocket.instances.length).toBe(2);

    const wsA = MockWebSocket.instances[0];
    wsA.simulateMessage({
      domain: "session",
      action: "initialized",
      payload: { session_id: "srv-a" },
    });
    const wsB = MockWebSocket.instances[1];
    wsB.simulateMessage({
      domain: "session",
      action: "initialized",
      payload: { session_id: "srv-b" },
    });

    store.sendPrompt("a", "msg-a");
    store.sendPrompt("b", "msg-b");

    const sessions = useWsSessionStore.getState().sessions;
    expect(sessions["a"].blocks[0].content).toBe("msg-a");
    expect(sessions["b"].blocks[0].content).toBe("msg-b");
  });

  describe("feature.renamed", () => {
    it("sets featureTitle on the session entry", async () => {
      useWsSessionStore.getState().connect("s1");
      await tick();
      const ws = getWs();
      ws.simulateMessage({
        domain: "session",
        action: "feature.renamed",
        payload: { feature_id: 1, title: "New Feature Name" },
      });
      expect(useWsSessionStore.getState().sessions["s1"].featureTitle).toBe("New Feature Name");
    });

    it("ignores feature.renamed with no title", async () => {
      useWsSessionStore.getState().connect("s1");
      await tick();
      const ws = getWs();
      ws.simulateMessage({
        domain: "session",
        action: "feature.renamed",
        payload: { feature_id: 1 },
      });
      expect(useWsSessionStore.getState().sessions["s1"].featureTitle).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // Plan approval gate flow
  // ---------------------------------------------------------------------------

  describe("plan approval gate", () => {
    async function setupWithInit() {
      return connectInitializedSession();
    }

    function streamExitPlanMode(ws: MockWebSocket) {
      ws.simulateMessage({
        domain: "session",
        action: "message",
        payload: {
          blocks: [
            {
              type: "assistant",
              message: {
                content: [
                  {
                    type: "tool_use",
                    id: "toolu_plan",
                    name: "ExitPlanMode",
                    input: { plan: "## My Plan" },
                  },
                ],
              },
            },
          ],
        },
      });
    }

    function sendPlanPermissionRequest(ws: MockWebSocket) {
      ws.simulateMessage({
        domain: "session",
        action: "permission.request",
        payload: {
          request_id: "req-plan-1",
          tool_name: "ExitPlanMode",
          tool_input: { plan: "## My Plan" },
          description: "Plan is ready for approval",
        },
      });
    }

    it("ExitPlanMode permission.request shows plan approval bar", async () => {
      const { ws } = await setupWithInit();
      streamExitPlanMode(ws);
      sendPlanPermissionRequest(ws);

      const session = useWsSessionStore.getState().sessions["s1"];
      expect(session.pendingPlanApproval).toEqual({ plan: "## My Plan" });
      expect(session.pendingRequestId).toBe("req-plan-1");
      expect(session.lifecycle).toEqual({
        phase: "paused",
        reason: "planApproval",
      });
    });

    it("keeps plan approval paused when the provider sends turn_complete after the plan", async () => {
      const { ws } = await setupWithInit();
      streamExitPlanMode(ws);
      sendPlanPermissionRequest(ws);

      ws.simulateMessage({
        domain: "session",
        action: "ended",
        payload: { reason: "turn_complete" },
      });

      const session = useWsSessionStore.getState().sessions["s1"];
      expect(session.pendingPlanApproval).toEqual({ plan: "## My Plan" });
      expect(session.lifecycle).toEqual({
        phase: "paused",
        reason: "planApproval",
      });
    });

    it("restores synthetic plan approval request id even when live blocks already exist", () => {
      const store = useWsSessionStore.getState();
      store.connect("s1");

      useWsSessionStore.setState(
        updateSession(useWsSessionStore.getState(), "s1", {
          blocks: [{ id: "live-1", type: "text" as const, content: "live block" }],
        }),
      );

      store.setPersistedState("s1", {
        blocks: [
          {
            id: "plan-1",
            type: "tool_call" as const,
            content: "",
            toolName: "ExitPlanMode",
          },
        ],
        lifecycle: { phase: "terminal", reason: "completed" },
        pendingPlanApproval: { plan: "## Restored Plan" },
      });

      const session = useWsSessionStore.getState().sessions["s1"];
      expect(session.pendingPlanApproval).toEqual({ plan: "## Restored Plan" });
      expect(session.pendingRequestId).toMatch(/^plan_restore_/);
      expect(session.lifecycle).toEqual({
        phase: "paused",
        reason: "planApproval",
      });
    });

    it("approvePlan sends permission.respond and waits for backend mode.changed", async () => {
      const { ws } = await setupWithInit();
      streamExitPlanMode(ws);
      sendPlanPermissionRequest(ws);

      const modeBeforeApproval = useWsSessionStore.getState().sessions["s1"].permissionMode;
      // Snapshot the wire boundary before approval so the post-approval
      // mode.set check ignores the init-time mode replay that
      // `buildQueuedInitEnvelopes` emits for every mode.
      const sentBeforeApproval = ws.sent.length;

      useWsSessionStore.getState().approvePlan("s1");

      // Approval clears the gate immediately, but the chip is unchanged
      // until the backend bridge has actually pushed
      // `set_permission_mode` to the CLI and broadcast `mode.changed`.
      // Anything else would let the chip lie about CLI state.
      let session = useWsSessionStore.getState().sessions["s1"];
      expect(session.pendingPlanApproval).toBeNull();
      expect(session.pendingRequestId).toBe("");
      expect(session.permissionMode).toBe(modeBeforeApproval);
      expect(session.lifecycle).toEqual({ phase: "active" });

      // FE must NOT race-send `mode.set` itself — the backend bridge owns
      // the post-approval mode transition (atomic with returning Allow).
      const sent = ws.sent.map((s) => JSON.parse(s));
      const sentAfterApproval = sent.slice(sentBeforeApproval);
      const modeSet = sentAfterApproval.find(
        (m: Record<string, unknown>) => m.action === "mode.set",
      );
      expect(modeSet).toBeUndefined();

      const permResp = sent.find((m: Record<string, unknown>) => m.action === "permission.respond");
      expect(permResp).toBeDefined();
      expect(permResp.payload.request_id).toBe("req-plan-1");
      expect(permResp.payload.decision).toBe("allow_once");

      // Backend confirms post-plan mode → chip flips.
      ws.simulateMessage({
        domain: "session",
        action: "mode.changed",
        payload: { mode: "auto" },
      });
      session = useWsSessionStore.getState().sessions["s1"];
      expect(session.permissionMode).toBe("auto");
    });

    it("approvePlan does not optimistically write the chip mode (backend wins)", async () => {
      const { ws } = await setupWithInit();
      // Switch the session to Codex before approving — even though the FE
      // catalog has its own per-provider primary, the FE must not guess at
      // the post-approval mode anymore. The backend resolves it from its
      // own adapter matrix and broadcasts via `mode.changed`.
      useWsSessionStore.setState((state) =>
        updateSession(state, "s1", { currentProviderId: "codex_cli" }),
      );
      streamExitPlanMode(ws);
      sendPlanPermissionRequest(ws);

      const sentBeforeApproval = ws.sent.length;
      useWsSessionStore.getState().approvePlan("s1");

      const sent = ws.sent.map((s) => JSON.parse(s));
      const sentAfterApproval = sent.slice(sentBeforeApproval);
      expect(
        sentAfterApproval.find((m: Record<string, unknown>) => m.action === "mode.set"),
      ).toBeUndefined();

      ws.simulateMessage({
        domain: "session",
        action: "mode.changed",
        payload: { mode: "default" },
      });
      const session = useWsSessionStore.getState().sessions["s1"];
      expect(session.permissionMode).toBe("default");
    });

    it("approvePlan adds 'Plan approved.' user message and marks plan block approved", async () => {
      const { ws } = await setupWithInit();
      streamExitPlanMode(ws);
      sendPlanPermissionRequest(ws);

      useWsSessionStore.getState().approvePlan("s1");

      const session = useWsSessionStore.getState().sessions["s1"];
      const userMsgs = session.blocks.filter((b) => b.type === "user_message");
      expect(userMsgs).toHaveLength(1);
      expect(userMsgs[0].content).toBe("Plan approved.");

      const planBlock = session.blocks.find((b) => b.toolName === "ExitPlanMode");
      expect(planBlock?.planApprovalStatus).toBe("approved");
    });

    it("requestPlanChanges sends permission.respond with deny and feedback", async () => {
      const { ws } = await setupWithInit();
      streamExitPlanMode(ws);
      sendPlanPermissionRequest(ws);

      useWsSessionStore.getState().requestPlanChanges("s1", "Use a simpler approach");

      const session = useWsSessionStore.getState().sessions["s1"];
      expect(session.pendingPlanApproval).toBeNull();
      expect(session.pendingRequestId).toBe("");
      expect(session.lifecycle).toEqual({ phase: "active" });

      const sent = ws.sent.map((s) => JSON.parse(s));
      const permResp = sent.find((m: Record<string, unknown>) => m.action === "permission.respond");
      expect(permResp).toBeDefined();
      expect(permResp.payload.decision).toBe("deny");
      expect(permResp.payload.feedback).toBe("Use a simpler approach");
    });

    it("requestPlanChanges adds feedback as user message and marks plan block rejected", async () => {
      const { ws } = await setupWithInit();
      streamExitPlanMode(ws);
      sendPlanPermissionRequest(ws);

      useWsSessionStore.getState().requestPlanChanges("s1", "Try again differently");

      const session = useWsSessionStore.getState().sessions["s1"];
      const userMsgs = session.blocks.filter((b) => b.type === "user_message");
      expect(userMsgs).toHaveLength(1);
      expect(userMsgs[0].content).toBe("Try again differently");

      const planBlock = session.blocks.find((b) => b.toolName === "ExitPlanMode");
      expect(planBlock?.planApprovalStatus).toBe("rejected");
    });

    it("requestPlanChanges with empty feedback skips user message block", async () => {
      const { ws } = await setupWithInit();
      streamExitPlanMode(ws);
      sendPlanPermissionRequest(ws);

      useWsSessionStore.getState().requestPlanChanges("s1", "");

      const session = useWsSessionStore.getState().sessions["s1"];
      const userMsgs = session.blocks.filter((b) => b.type === "user_message");
      expect(userMsgs).toHaveLength(0);

      const planBlock = session.blocks.find((b) => b.toolName === "ExitPlanMode");
      expect(planBlock?.planApprovalStatus).toBe("rejected");
    });

    it("turn_complete after gate-based approval does not re-trigger approval bar", async () => {
      const { ws } = await setupWithInit();
      streamExitPlanMode(ws);
      sendPlanPermissionRequest(ws);
      useWsSessionStore.getState().approvePlan("s1");

      // Simulate turn_complete after the CLI resumes
      ws.simulateMessage({
        domain: "session",
        action: "turn_complete",
        payload: {},
      });

      const session = useWsSessionStore.getState().sessions["s1"];
      expect(session.pendingPlanApproval).toBeNull();
      expect(session.lifecycle).toEqual({
        phase: "terminal",
        reason: "completed",
      });
    });
  });

  // ---------------------------------------------------------------------------
  // EnterPlanMode detection
  // ---------------------------------------------------------------------------

  describe("EnterPlanMode detection", () => {
    it("EnterPlanMode in stream switches permissionMode to plan", async () => {
      const store = useWsSessionStore.getState();
      store.connect("s1");
      await tick();
      const ws = getWs();
      ws.simulateMessage({
        domain: "session",
        action: "initialized",
        payload: { session_id: "srv-1" },
      });

      ws.simulateMessage({
        domain: "session",
        action: "message",
        payload: {
          blocks: [
            {
              type: "assistant",
              message: {
                content: [
                  {
                    type: "tool_use",
                    id: "tu-enter",
                    name: "EnterPlanMode",
                    input: {},
                  },
                ],
              },
            },
          ],
        },
      });

      expect(useWsSessionStore.getState().sessions["s1"].permissionMode).toBe("plan");
    });

    it("EnterPlanMode is consumed as a message-local signal", async () => {
      const store = useWsSessionStore.getState();
      store.connect("s1");
      await tick();
      const ws = getWs();
      ws.simulateMessage({
        domain: "session",
        action: "initialized",
        payload: { session_id: "srv-1" },
      });

      ws.simulateMessage({
        domain: "session",
        action: "message",
        payload: {
          blocks: [
            {
              type: "assistant",
              message: {
                content: [
                  {
                    type: "tool_use",
                    id: "tu-enter",
                    name: "EnterPlanMode",
                    input: {},
                  },
                ],
              },
            },
          ],
        },
      });

      const session = useWsSessionStore.getState().sessions["s1"];
      expect(session.permissionMode).toBe("plan");
      // Lifecycle has been "active" since the prompt; permissionMode change
      // shouldn't push it to terminal/idle.
      expect(session.lifecycle).toEqual({ phase: "active" });
    });
  });

  describe("permission denial does not mark turn terminal", () => {
    async function setupPermissionPending(): Promise<MockWebSocket> {
      const store = useWsSessionStore.getState();
      store.connect("s1");
      await tick();
      const ws = getWs();
      ws.simulateMessage({
        domain: "session",
        action: "initialized",
        payload: { session_id: "srv-1" },
      });
      ws.simulateMessage({
        domain: "session",
        action: "permission.request",
        payload: {
          request_id: "req-1",
          tool_name: "Bash",
          tool_input: { command: "ls" },
          description: "run ls",
        },
      });
      return ws;
    }

    it("respondToPermission deny clears pending fields after backend ack", async () => {
      const ws = await setupPermissionPending();
      expect(useWsSessionStore.getState().sessions["s1"].lifecycle).toEqual({
        phase: "paused",
        reason: "permission",
      });

      useWsSessionStore.getState().respondToPermission("s1", "req-1", "deny");

      let session = useWsSessionStore.getState().sessions["s1"];
      expect(session.pendingPermission?.requestId).toBe("req-1");
      const sent = JSON.parse(ws.sent.at(-1)!);
      ws.simulateMessage({
        domain: "session",
        action: "acknowledged",
        ref: sent.id,
        payload: { action: "permission.respond" },
      });
      await Promise.resolve();

      session = useWsSessionStore.getState().sessions["s1"];
      expect(session.pendingPermission).toBeNull();
      expect(session.pendingRequestId).toBe("");
      expect(session.lifecycle).toEqual({
        phase: "paused",
        reason: "permission",
      });
    });

    it("respondToPermission allow clears pending fields after backend ack", async () => {
      const ws = await setupPermissionPending();

      useWsSessionStore.getState().respondToPermission("s1", "req-1", "allow_once");

      let session = useWsSessionStore.getState().sessions["s1"];
      expect(session.pendingPermission?.requestId).toBe("req-1");
      const sent = JSON.parse(ws.sent.at(-1)!);
      ws.simulateMessage({
        domain: "session",
        action: "acknowledged",
        ref: sent.id,
        payload: { action: "permission.respond" },
      });
      await Promise.resolve();

      session = useWsSessionStore.getState().sessions["s1"];
      expect(session.pendingPermission).toBeNull();
      expect(session.pendingRequestId).toBe("");
      expect(session.lifecycle).toEqual({
        phase: "paused",
        reason: "permission",
      });
    });

    it("respondToPermission uses the current pending request id after the queue advances", async () => {
      const ws = await setupPermissionPending();
      ws.simulateMessage({
        domain: "session",
        action: "permission.request",
        payload: {
          request_id: "req-2",
          tool_name: "Bash",
          tool_input: { command: "pwd" },
          description: "run pwd",
        },
      });

      useWsSessionStore.getState().respondToPermission("s1", "req-1", "allow_once");
      let sent = JSON.parse(ws.sent.at(-1)!);
      ws.simulateMessage({
        domain: "session",
        action: "acknowledged",
        ref: sent.id,
        payload: { action: "permission.respond" },
      });
      await Promise.resolve();
      expect(useWsSessionStore.getState().sessions["s1"].pendingPermission?.requestId).toBe(
        "req-2",
      );

      useWsSessionStore.getState().respondToPermission("s1", "req-1", "allow_once");

      sent = JSON.parse(ws.sent.at(-1)!);
      expect(sent.payload.request_id).toBe("req-2");
    });

    it("paused lifecycle returns to active when the agent keeps streaming after a deny", async () => {
      const ws = await setupPermissionPending();
      useWsSessionStore.getState().respondToPermission("s1", "req-1", "deny");

      ws.simulateMessage({
        domain: "session",
        action: "message",
        payload: {
          blocks: [
            {
              type: "assistant",
              message: { content: [{ type: "text", text: "ok, skipping" }] },
            },
          ],
        },
      });

      expect(useWsSessionStore.getState().sessions["s1"].lifecycle).toEqual({
        phase: "active",
      });
    });
  });

  describe("lifecycle recovery on backend activity", () => {
    async function setupActiveSession(): Promise<MockWebSocket> {
      const store = useWsSessionStore.getState();
      store.connect("s1");
      await tick();
      const ws = getWs();
      ws.simulateMessage({
        domain: "session",
        action: "initialized",
        payload: { session_id: "srv-1" },
      });
      return ws;
    }

    function streamTextMessage(ws: MockWebSocket, text: string): void {
      ws.simulateMessage({
        domain: "session",
        action: "message",
        payload: {
          blocks: [
            {
              type: "assistant",
              message: { content: [{ type: "text", text }] },
            },
          ],
        },
      });
    }

    it("terminal lifecycle returns to active when a new turn streams", async () => {
      const ws = await setupActiveSession();

      ws.simulateMessage({
        domain: "session",
        action: "turn_complete",
        payload: {},
      });
      expect(useWsSessionStore.getState().sessions["s1"].lifecycle).toEqual({
        phase: "terminal",
        reason: "completed",
      });

      streamTextMessage(ws, "turn 2 starting");

      expect(useWsSessionStore.getState().sessions["s1"].lifecycle).toEqual({
        phase: "active",
      });
    });

    it("error lifecycle returns to active when the stream resumes", async () => {
      const ws = await setupActiveSession();

      ws.simulateMessage({
        domain: "session",
        action: "error",
        payload: { code: "SDK_ERROR", message: "transient" },
      });
      expect(useWsSessionStore.getState().sessions["s1"].lifecycle.phase).toBe("error");

      streamTextMessage(ws, "recovered");

      expect(useWsSessionStore.getState().sessions["s1"].lifecycle).toEqual({
        phase: "active",
      });
    });

    it("records active and user-pending timing across permission-gated turns", async () => {
      const ws = await setupActiveSession();
      vi.useFakeTimers();
      vi.setSystemTime(1_000);
      const store = useWsSessionStore.getState();

      store.sendPrompt("s1", "build it");
      vi.setSystemTime(4_000);
      ws.simulateMessage({
        domain: "session",
        action: "permission.request",
        payload: { request_id: "req-1", tool_name: "Bash", tool_input: {} },
      });
      vi.setSystemTime(9_000);
      streamTextMessage(ws, "resumed after permission");
      vi.setSystemTime(11_000);
      ws.simulateMessage({
        domain: "session",
        action: "turn_complete",
        payload: {},
      });

      const session = useWsSessionStore.getState().sessions["s1"];
      expect(session.turnTiming.completed).toEqual({
        totalMs: 7_000,
        activeMs: 2_000,
        userPendingMs: 5_000,
      });
      expect(session.blocks.at(-1)).toMatchObject({
        type: "turn_summary",
        content: "Worked - 7s · Agent 2s · Waiting 5s",
      });
      vi.useRealTimers();
    });

    it("adds a visible turn summary even when a turn completes without output blocks", async () => {
      const ws = await setupActiveSession();
      vi.useFakeTimers();
      vi.setSystemTime(1_000);

      streamTextMessage(ws, "");
      vi.setSystemTime(4_000);
      ws.simulateMessage({
        domain: "session",
        action: "turn_complete",
        payload: {},
      });

      expect(useWsSessionStore.getState().sessions["s1"].blocks.at(-1)).toMatchObject({
        type: "turn_summary",
        content: "Worked - 3s · Agent 3s · Waiting 0s",
      });
      vi.useRealTimers();
    });
  });

  describe("worktree events", () => {
    it("handles worktree.creating event from workflow domain", async () => {
      useWsSessionStore.getState().connect("s1");
      await tick();
      const ws = getWs();
      ws.simulateMessage({
        domain: "workflow",
        action: "worktree.creating",
        payload: { branch: "feature/test-abc", path: "/tmp/wt" },
      });
      const session = useWsSessionStore.getState().sessions["s1"];
      expect(session.worktreeStatus).toBe("creating");
      expect(session.worktreeBranch).toBe("feature/test-abc");
      expect(session.worktreePath).toBe("/tmp/wt");
      expect(invalidateWorktreeQueries).not.toHaveBeenCalled();
    });

    it("handles worktree.created event", async () => {
      useWsSessionStore.getState().connect("s1");
      await tick();
      const ws = getWs();
      ws.simulateMessage({
        domain: "workflow",
        action: "worktree.created",
        payload: { branch: "feature/test-abc", path: "/tmp/wt" },
      });
      const session = useWsSessionStore.getState().sessions["s1"];
      expect(session.worktreeStatus).toBe("created");
      expect(invalidateWorktreeQueries).toHaveBeenCalledTimes(1);
    });

    it("handles worktree.setup_output appending lines", async () => {
      useWsSessionStore.getState().connect("s1");
      await tick();
      const ws = getWs();
      ws.simulateMessage({
        domain: "workflow",
        action: "worktree.setup_running",
        payload: {},
      });
      ws.simulateMessage({
        domain: "workflow",
        action: "worktree.setup_output",
        payload: { line: "Installing deps..." },
      });
      ws.simulateMessage({
        domain: "workflow",
        action: "worktree.setup_output",
        payload: { line: "Done." },
      });
      const session = useWsSessionStore.getState().sessions["s1"];
      expect(session.worktreeStatus).toBe("setup_running");
      expect(session.worktreeSetupOutput).toEqual(["Installing deps...", "Done."]);
    });

    it("handles worktree.ready event", async () => {
      useWsSessionStore.getState().connect("s1");
      await tick();
      getWs().simulateMessage({
        domain: "workflow",
        action: "worktree.ready",
        payload: {},
      });
      expect(useWsSessionStore.getState().sessions["s1"].worktreeStatus).toBe("ready");
    });

    it("handles worktree.setup_error event", async () => {
      useWsSessionStore.getState().connect("s1");
      await tick();
      getWs().simulateMessage({
        domain: "workflow",
        action: "worktree.setup_error",
        payload: { error: "pnpm install failed" },
      });
      const session = useWsSessionStore.getState().sessions["s1"];
      expect(session.worktreeStatus).toBe("setup_error");
      expect(session.worktreeError).toBe("pnpm install failed");
    });

    it("retryWorktreeSetup sends feature-scoped envelope without optimistic update", async () => {
      useWsSessionStore.getState().connect("s1");
      await tick();
      const ws = getWs();
      // Initialize session
      ws.simulateMessage({
        domain: "session",
        action: "initialized",
        payload: { session_id: "db-1" },
      });
      const store = useWsSessionStore.getState();
      store.initSession("s1", { featureId: 42 });
      store.retryWorktreeSetup("s1");
      // Should NOT optimistically set status
      expect(useWsSessionStore.getState().sessions["s1"].worktreeStatus).toBe("idle");
      // Should have sent the envelope
      const sent = ws.sent.map((s) => JSON.parse(s));
      const retryMsg = sent.find((m) => m.action === "retry_worktree_setup");
      expect(retryMsg).toBeDefined();
      expect(retryMsg.payload.feature_id).toBe(42);
      ws.simulateMessage({
        domain: "session",
        action: "retry_worktree_setup.ok",
        ref: retryMsg.id,
        payload: { feature_id: 42 },
      });
    });

    it("shows retry request errors inline instead of adding conversation blocks", async () => {
      useWsSessionStore.getState().connect("s1");
      await tick();
      const ws = getWs();
      ws.simulateMessage({
        domain: "session",
        action: "initialized",
        payload: { session_id: "db-1" },
      });

      useWsSessionStore.getState().initSession("s1", { featureId: 42 });
      useWsSessionStore.getState().retryWorktreeSetup("s1");
      const sent = ws.sent.map((s) => JSON.parse(s));
      const retryMsg = sent.find((m) => m.action === "retry_worktree_setup");
      ws.simulateMessage({
        domain: "session",
        action: "error",
        ref: retryMsg.id,
        payload: {
          code: "NO_WORKTREE",
          message: "No worktree found for this feature",
        },
      });
      await Promise.resolve();

      const session = useWsSessionStore.getState().sessions["s1"];
      expect(session.worktreeStatus).toBe("setup_error");
      expect(session.worktreeError).toBe("No worktree found for this feature");
      expect(
        session.blocks.some(
          (block) => block.content === "Error: No worktree found for this feature",
        ),
      ).toBe(false);
    });
  });

  describe("compaction handling", () => {
    it("compactSession appends a local /compact user message", async () => {
      const store = useWsSessionStore.getState();
      store.connect("s1");
      await tick();
      const ws = getWs();
      ws.simulateMessage({
        domain: "session",
        action: "initialized",
        payload: { session_id: "srv-1" },
      });

      store.compactSession("s1");

      const sent = ws.sent.map((s) => JSON.parse(s));
      expect(sent.some((message) => message.action === "compact")).toBe(true);
      const session = useWsSessionStore.getState().sessions["s1"];
      expect(session.blocks.at(-1)?.type).toBe("user_message");
      expect(session.blocks.at(-1)?.content).toBe("/compact");
      expect(session.lifecycle).toEqual({ phase: "idle" });
      expect(session.compactRequestPending).toBe(true);
      expect(session.pendingManualCompact).toBe(false);
    });

    it("compactSession ignores duplicate manual compact while one is pending", async () => {
      const store = useWsSessionStore.getState();
      store.connect("s1");
      await tick();
      const ws = getWs();
      ws.simulateMessage({
        domain: "session",
        action: "initialized",
        payload: { session_id: "srv-1" },
      });

      store.compactSession("s1");
      store.compactSession("s1");

      const sent = ws.sent
        .map((s) => JSON.parse(s))
        .filter((message) => message.action === "compact");
      const session = useWsSessionStore.getState().sessions["s1"];
      expect(sent).toHaveLength(1);
      expect(session.blocks.filter((block) => block.type === "user_message")).toHaveLength(1);
    });

    it("compact.started keeps the manual compact lifecycle running", async () => {
      const store = useWsSessionStore.getState();
      store.connect("s1");
      await tick();
      const ws = getWs();
      ws.simulateMessage({
        domain: "session",
        action: "initialized",
        payload: { session_id: "srv-1" },
      });

      store.compactSession("s1");
      ws.simulateMessage({
        domain: "session",
        action: "compact.started",
        payload: null,
      });
      ws.simulateMessage({
        domain: "session",
        action: "compact.started",
        payload: null,
      });
      ws.simulateMessage({
        domain: "session",
        action: "compact.started",
        payload: null,
      });
      ws.simulateMessage({
        domain: "session",
        action: "compact.started",
        payload: null,
      });

      const session = useWsSessionStore.getState().sessions["s1"];
      expect(session.lifecycle).toEqual({ phase: "idle" });
      expect(session.compactRequestPending).toBe(false);
      expect(session.pendingManualCompact).toBe(true);
    });

    it("compact.ok completes the compact lifecycle", async () => {
      const store = useWsSessionStore.getState();
      store.connect("s1");
      await tick();
      const ws = getWs();
      ws.simulateMessage({
        domain: "session",
        action: "initialized",
        payload: { session_id: "srv-1" },
      });

      store.compactSession("s1");
      ws.simulateMessage({
        domain: "session",
        action: "compact.started",
        payload: null,
      });
      ws.simulateMessage({
        domain: "session",
        action: "compact.ok",
        payload: null,
      });

      const session = useWsSessionStore.getState().sessions["s1"];
      expect(session.lifecycle).toEqual({
        phase: "terminal",
        reason: "completed",
      });
      expect(session.pendingManualCompact).toBe(false);
    });

    it("appends a compact_divider block for system.compact_boundary", async () => {
      const store = useWsSessionStore.getState();
      store.connect("s1");
      await tick();
      const ws = getWs();
      ws.simulateMessage({
        domain: "session",
        action: "initialized",
        payload: { session_id: "srv-1" },
      });

      ws.simulateMessage({
        domain: "session",
        action: "message",
        payload: {
          blocks: [
            {
              type: "system",
              subtype: "compact_boundary",
              uuid: "cb1",
              session_id: "srv-1",
              compact_metadata: { trigger: "auto", pre_tokens: 90000 },
            },
          ],
        },
      });

      const session = useWsSessionStore.getState().sessions["s1"];
      const divider = session.blocks.find((b) => b.type === "compact_divider");
      expect(divider).toBeDefined();
      expect(divider?.content).toContain('"trigger":"auto"');
      expect(divider?.content).toContain('"pre_tokens":90000');
    });

    it("manual compact completes when the compact boundary arrives", async () => {
      const store = useWsSessionStore.getState();
      store.connect("s1");
      await tick();
      const ws = getWs();
      ws.simulateMessage({
        domain: "session",
        action: "initialized",
        payload: { session_id: "srv-1" },
      });

      store.compactSession("s1");
      ws.simulateMessage({
        domain: "session",
        action: "compact.started",
        payload: null,
      });
      ws.simulateMessage({
        domain: "session",
        action: "message",
        payload: {
          blocks: [
            {
              type: "system",
              subtype: "compact_boundary",
              uuid: "cb1",
              session_id: "srv-1",
              compact_metadata: { trigger: "manual", pre_tokens: 90000 },
            },
          ],
        },
      });

      const session = useWsSessionStore.getState().sessions["s1"];
      expect(session.lifecycle).toEqual({
        phase: "terminal",
        reason: "completed",
      });
      expect(session.pendingManualCompact).toBe(false);
    });

    it("manual compact completes for compact boundaries without trigger metadata", async () => {
      const store = useWsSessionStore.getState();
      store.connect("s1");
      await tick();
      const ws = getWs();
      ws.simulateMessage({
        domain: "session",
        action: "initialized",
        payload: { session_id: "srv-1" },
      });

      store.compactSession("s1");
      ws.simulateMessage({
        domain: "session",
        action: "compact.started",
        payload: null,
      });
      ws.simulateMessage({
        domain: "session",
        action: "message",
        payload: {
          blocks: [
            {
              type: "system",
              subtype: "compact_boundary",
              uuid: "cb1",
              session_id: "srv-1",
            },
          ],
        },
      });

      const session = useWsSessionStore.getState().sessions["s1"];
      expect(session.lifecycle).toEqual({
        phase: "terminal",
        reason: "completed",
      });
      expect(session.pendingManualCompact).toBe(false);
    });

    it("auto compact boundary does not complete a pending manual compact", async () => {
      const store = useWsSessionStore.getState();
      store.connect("s1");
      await tick();
      const ws = getWs();
      ws.simulateMessage({
        domain: "session",
        action: "initialized",
        payload: { session_id: "srv-1" },
      });

      store.compactSession("s1");
      ws.simulateMessage({
        domain: "session",
        action: "compact.started",
        payload: null,
      });
      ws.simulateMessage({
        domain: "session",
        action: "message",
        payload: {
          blocks: [
            {
              type: "system",
              subtype: "compact_boundary",
              uuid: "cb1",
              session_id: "srv-1",
              compact_metadata: { trigger: "auto", pre_tokens: 90000 },
            },
          ],
        },
      });

      const session = useWsSessionStore.getState().sessions["s1"];
      expect(session.lifecycle).toEqual({ phase: "active" });
      expect(session.pendingManualCompact).toBe(true);
    });

    it("errors during compaction surface inline without stopping the agent", async () => {
      // Steering a prompt during /compact fails on the runtime side; the
      // backend reports `session.error` even though compaction is still
      // running. The UI must surface the error inline and leave the
      // compaction lifecycle untouched (no fake "stopped" state).
      const store = useWsSessionStore.getState();
      store.connect("s1");
      await tick();
      const ws = getWs();
      ws.simulateMessage({
        domain: "session",
        action: "initialized",
        payload: { session_id: "srv-1" },
      });

      store.compactSession("s1");
      ws.simulateMessage({
        domain: "session",
        action: "compact.started",
        payload: null,
      });
      ws.simulateMessage({
        domain: "session",
        action: "error",
        payload: { code: "SDK_ERROR", message: "compact failed" },
      });

      const session = useWsSessionStore.getState().sessions["s1"];
      expect(session.pendingManualCompact).toBe(true);
      expect(session.lifecycle.phase).not.toBe("error");
      const errorBlock = session.blocks.find((b) => b.type === "error");
      expect(errorBlock?.content).toBe("compact failed");
      expect(errorBlock?.errorCode).toBe("SDK_ERROR");
    });

    it("sets contextUsage.wasCompacted when compact_boundary arrives", async () => {
      const store = useWsSessionStore.getState();
      store.connect("s1");
      await tick();
      const ws = getWs();
      ws.simulateMessage({
        domain: "session",
        action: "initialized",
        payload: {
          session_id: "srv-1",
          input_tokens: 1000,
          output_tokens: 500,
          context_window: 200000,
        },
      });

      ws.simulateMessage({
        domain: "session",
        action: "message",
        payload: {
          blocks: [
            {
              type: "system",
              subtype: "compact_boundary",
              uuid: "cb1",
              session_id: "srv-1",
              compact_metadata: { trigger: "manual", pre_tokens: 180000 },
            },
          ],
        },
      });

      const session = useWsSessionStore.getState().sessions["s1"];
      expect(session.contextUsage?.wasCompacted).toBe(true);
      // Other usage fields must be preserved.
      expect(session.contextUsage?.inputTokens).toBe(1000);
      expect(session.contextUsage?.outputTokens).toBe(500);
      expect(session.contextUsage?.contextWindow).toBe(200000);
    });

    it("seeds contextUsage when compact_boundary arrives before any usage update", async () => {
      const store = useWsSessionStore.getState();
      store.connect("s1");
      await tick();
      const ws = getWs();
      ws.simulateMessage({
        domain: "session",
        action: "initialized",
        payload: { session_id: "srv-1" },
      });

      ws.simulateMessage({
        domain: "session",
        action: "message",
        payload: {
          blocks: [
            {
              type: "system",
              subtype: "compact_boundary",
              uuid: "cb1",
              session_id: "srv-1",
              compact_metadata: { trigger: "auto", pre_tokens: 0 },
            },
          ],
        },
      });

      const session = useWsSessionStore.getState().sessions["s1"];
      expect(session.contextUsage?.wasCompacted).toBe(true);
    });

    it("ignores non-compact system subtypes", async () => {
      const store = useWsSessionStore.getState();
      store.connect("s1");
      await tick();
      const ws = getWs();
      ws.simulateMessage({
        domain: "session",
        action: "initialized",
        payload: { session_id: "srv-1" },
      });

      ws.simulateMessage({
        domain: "session",
        action: "message",
        payload: {
          blocks: [
            {
              type: "system",
              subtype: "init",
              uuid: "si1",
              session_id: "srv-1",
              model: "claude-sonnet-4-5",
            },
          ],
        },
      });

      const session = useWsSessionStore.getState().sessions["s1"];
      expect(session.blocks.some((b) => b.type === "compact_divider")).toBe(false);
      expect(session.contextUsage?.wasCompacted ?? false).toBe(false);
    });

    it("appends a compact_divider block for OpenCode compaction user messages", async () => {
      const store = useWsSessionStore.getState();
      store.connect("s1");
      await tick();
      const ws = getWs();
      ws.simulateMessage({
        domain: "session",
        action: "initialized",
        payload: { session_id: "srv-1" },
      });

      ws.simulateMessage({
        domain: "session",
        action: "message",
        payload: {
          blocks: [
            {
              type: "user",
              session_id: "srv-1",
              message: {
                content: [
                  {
                    type: "compaction",
                    auto: false,
                    overflow: false,
                  },
                ],
              },
            },
          ],
        },
      });

      const session = useWsSessionStore.getState().sessions["s1"];
      expect(session.blocks.some((b) => b.type === "compact_divider")).toBe(true);
      expect(session.contextUsage?.wasCompacted).toBe(true);
    });
  });

  describe("slash command requests", () => {
    it("re-requests slash commands when the provider changes", async () => {
      const store = useWsSessionStore.getState();
      store.connect("s1");
      await tick();
      const ws = getWs();

      store.requestSlashCommands("s1", "/repo", "claude_code");
      const firstRequest = JSON.parse(ws.sent[ws.sent.length - 1]);
      expect(firstRequest.payload.provider).toBe("claude_code");

      useWsSessionStore.setState((state) =>
        updateSession(state, "s1", {
          slashCommands: [{ name: "compact", description: "Compact", kind: "command" }],
          slashCommandsLoading: false,
          slashCommandsKey: "claude_code::/repo",
          slashCommandsRequestRef: firstRequest.id,
        }),
      );

      store.requestSlashCommands("s1", "/repo", "opencode");

      const secondRequest = JSON.parse(ws.sent[ws.sent.length - 1]);
      expect(secondRequest.payload.provider).toBe("opencode");
      expect(useWsSessionStore.getState().sessions["s1"].slashCommandsRequestRef).toBe(
        secondRequest.id,
      );
      expect(useWsSessionStore.getState().sessions["s1"].slashCommandsLoading).toBe(true);
      expect(useWsSessionStore.getState().sessions["s1"].slashCommands).toEqual([]);
    });

    it("re-requests slash commands for the same provider and cwd after commands are loaded", async () => {
      const store = useWsSessionStore.getState();
      store.connect("s1");
      await tick();
      const ws = getWs();

      useWsSessionStore.setState((state) =>
        updateSession(state, "s1", {
          slashCommands: [{ name: "compact", description: "Compact", kind: "command" }],
          slashCommandsLoading: false,
          slashCommandsKey: "codex_cli::/repo",
          slashCommandsRequestRef: "previous-request",
        }),
      );

      store.requestSlashCommands("s1", "/repo", "codex_cli");

      const request = JSON.parse(ws.sent[ws.sent.length - 1]);
      const session = useWsSessionStore.getState().sessions["s1"];
      expect(request.domain).toBe("commands");
      expect(request.action).toBe("get");
      expect(request.payload.provider).toBe("codex_cli");
      expect(session.slashCommands).toEqual([
        { name: "compact", description: "Compact", kind: "command" },
      ]);
      expect(session.slashCommandsLoading).toBe(true);
      expect(session.slashCommandsRequestRef).toBe(request.id);
    });

    it("ignores stale slash command responses for an older provider", async () => {
      const store = useWsSessionStore.getState();
      store.connect("s1");
      await tick();
      const ws = getWs();

      store.requestSlashCommands("s1", "/repo", "opencode");
      const request = JSON.parse(ws.sent[ws.sent.length - 1]);

      ws.simulateMessage({
        ref: "older-request",
        domain: "commands",
        action: "list",
        payload: {
          commands: [{ name: "compact", description: "Claude compact", kind: "command" }],
        },
      });

      const session = useWsSessionStore.getState().sessions["s1"];
      expect(session.slashCommands).toEqual([]);
      expect(session.slashCommandsLoading).toBe(true);
      expect(session.slashCommandsRequestRef).toBe(request.id);
    });
  });

  describe("applyMutations – toolArgs during streaming", () => {
    it("preserves toolArgs when content is partial JSON", () => {
      const validArgs = JSON.stringify({
        description: "Find files",
        prompt: "search",
      });
      const existing = [
        {
          id: "b1",
          type: "tool_call" as const,
          content: validArgs,
          toolName: "Agent",
          toolArgs: validArgs,
        },
      ];
      const streamState = createStreamingState();
      // Simulate a streaming delta that makes content partial JSON
      const result = applyMutations(
        existing,
        [
          {
            action: "replace",
            block: {
              id: "b1",
              type: "tool_call",
              content: '{"description": "Fi',
              toolName: "Agent",
            },
          },
        ],
        streamState,
      );
      // toolArgs should still hold the previous valid value
      expect(result[0].toolArgs).toBe(validArgs);
    });

    it("updates toolArgs when content becomes valid JSON", () => {
      const existing = [
        {
          id: "b1",
          type: "tool_call" as const,
          content: "",
          toolName: "Agent",
          toolArgs: "",
        },
      ];
      const streamState = createStreamingState();
      const newArgs = JSON.stringify({ description: "Run tests" });
      const result = applyMutations(
        existing,
        [
          {
            action: "replace",
            block: {
              id: "b1",
              type: "tool_call",
              content: newArgs,
              toolName: "Agent",
            },
          },
        ],
        streamState,
      );
      expect(result[0].toolArgs).toBe(newArgs);
    });

    it("preserves child block toolArgs when content is partial JSON", () => {
      const validArgs = JSON.stringify({ description: "Explore code" });
      const parent = {
        id: "p1",
        type: "tool_call" as const,
        content: "{}",
        toolName: "Agent",
        toolUseId: "tu1",
        childBlocks: [
          {
            id: "c1",
            type: "tool_call" as const,
            content: validArgs,
            toolName: "Read",
            toolArgs: validArgs,
          },
        ],
      };
      const streamState = createStreamingState();
      streamState.toolUseIdToBlock.set("tu1", parent);
      // Update targets child block (not found in root, so falls through to child search)
      applyMutations(
        [],
        [
          {
            action: "replace",
            block: {
              id: "c1",
              type: "tool_call",
              content: '{"desc',
              toolName: "Read",
            },
          },
        ],
        streamState,
      );
      const updatedChild = streamState.toolUseIdToBlock.get("tu1")!.childBlocks![0];
      expect(updatedChild.toolArgs).toBe(validArgs);
    });
  });
});
