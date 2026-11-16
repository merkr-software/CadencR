import { describe, it, expect, vi } from "vitest";
import { createStreamingState, processSdkMessage } from "./ws-message-processing";

describe("processSdkMessage – system messages", () => {
  it("logs every system message with [AGENT-SYSTEM] prefix", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const state = createStreamingState();
    try {
      processSdkMessage({ type: "system", subtype: "init", session_id: "s1" }, state);
      expect(info).toHaveBeenCalled();
      const [prefix, payload] = info.mock.calls[0];
      expect(prefix).toBe("[AGENT-SYSTEM] init");
      expect(payload).toMatchObject({ type: "system", subtype: "init" });
    } finally {
      info.mockRestore();
    }
  });

  it("emits a compact_divider append + compactBoundaryObserved signal", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const state = createStreamingState();
    try {
      const result = processSdkMessage(
        {
          type: "system",
          subtype: "compact_boundary",
          session_id: "s1",
          compact_metadata: { trigger: "auto", pre_tokens: 90000 },
        },
        state,
      );
      expect(result.signals.compactBoundaryObserved).toBe(true);
      expect(result.mutations).toHaveLength(1);
      const mutation = result.mutations[0];
      expect(mutation.action).toBe("append");
      expect(mutation.block.type).toBe("compact_divider");
      expect(mutation.block.content).toContain('"trigger":"auto"');
    } finally {
      info.mockRestore();
    }
  });

  it("emits no mutation for non-compact system subtypes", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const state = createStreamingState();
    try {
      const result = processSdkMessage(
        { type: "system", subtype: "init", session_id: "s1" },
        state,
      );
      expect(result.mutations).toHaveLength(0);
      expect(result.signals.compactBoundaryObserved).toBe(false);
    } finally {
      info.mockRestore();
    }
  });
});

describe("processSdkMessage – Bash stream events", () => {
  it("uses backend agent_message_id as the streamed block id", () => {
    const state = createStreamingState();
    const start = processSdkMessage(
      {
        type: "stream_event",
        agent_message_id: 42,
        session_id: "s1",
        event: {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "Hel" },
        },
      },
      state,
    );
    const delta = processSdkMessage(
      {
        type: "stream_event",
        agent_message_id: 42,
        session_id: "s1",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "lo" },
        },
      },
      state,
    );

    expect(start.mutations[0].block).toMatchObject({ id: "msg-42", content: "Hel" });
    expect(delta.mutations[0].block).toMatchObject({ id: "msg-42", content: "lo" });
  });

  it("keeps the initial Bash command available before output deltas arrive", () => {
    const state = createStreamingState();
    const result = processSdkMessage(
      {
        type: "stream_event",
        session_id: "s1",
        event: {
          type: "content_block_start",
          index: 1,
          content_block: {
            type: "tool_use",
            id: "cmd",
            name: "Bash",
            input: { command: "git status", status: "running" },
          },
        },
      },
      state,
    );

    expect(result.mutations).toHaveLength(1);
    expect(JSON.parse(result.mutations[0].block.toolArgs ?? "{}")).toEqual({
      command: "git status",
      status: "running",
    });
  });

  it.each([
    ["Read", { file_path: "packages/service/src/main.rs" }],
    ["LS", { path: "packages/service/src" }],
    ["Grep", { pattern: "rawResponseItem", path: "packages/service/src" }],
    ["Glob", { pattern: "**/*.rs" }],
    [
      "WebFetch",
      {
        url: "https://example.com/docs",
        raw_item: { name: "web_fetch", arguments: { url: "https://example.com/docs" } },
      },
    ],
    ["TaskCreate", { subject: "Create task", activeForm: "Creating task" }],
    ["TaskUpdate", { taskId: "task-1", status: "in_progress", activeForm: "Doing task" }],
  ])("keeps initial %s input for generic Codex tools", (toolName, input) => {
    const state = createStreamingState();
    const result = processSdkMessage(
      {
        type: "stream_event",
        session_id: "s1",
        event: {
          type: "content_block_start",
          index: 1,
          content_block: {
            type: "tool_use",
            id: toolName,
            name: toolName,
            input,
          },
        },
      },
      state,
    );

    expect(result.mutations).toHaveLength(1);
    expect(result.mutations[0].block.toolName).toBe(toolName);
    expect(JSON.parse(result.mutations[0].block.toolArgs ?? "{}")).toEqual(input);
  });

  it("keeps initial ApplyPatch input for file changes", () => {
    const state = createStreamingState();
    const result = processSdkMessage(
      {
        type: "stream_event",
        session_id: "s1",
        event: {
          type: "content_block_start",
          index: 1,
          content_block: {
            type: "tool_use",
            id: "patch",
            name: "ApplyPatch",
            input: {
              patch_text:
                "*** Begin Patch\n*** Update File: toto.txt\n@@\n-old\n+new\n*** End Patch",
            },
          },
        },
      },
      state,
    );

    expect(result.mutations).toHaveLength(1);
    expect(result.mutations[0].block.toolName).toBe("ApplyPatch");
    expect(JSON.parse(result.mutations[0].block.toolArgs ?? "{}")).toEqual({
      patch_text: "*** Begin Patch\n*** Update File: toto.txt\n@@\n-old\n+new\n*** End Patch",
    });
  });
});

describe("server-stamped model on stream events", () => {
  it("labels streamed text with the stamped model when message_start was missed", () => {
    const state = createStreamingState();
    // A remote device that joined the turn late never saw `message_start`, so it
    // relies on the model the server stamps onto the forwarded block.
    const result = processSdkMessage(
      {
        type: "stream_event",
        session_id: "thread",
        model: "claude-opus-4-8",
        event: {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "Hi" },
        },
      },
      state,
    );

    expect(result.mutations).toHaveLength(1);
    expect(result.mutations[0].block.type).toBe("text");
    expect(result.mutations[0].block.model).toBe("claude-opus-4-8");
  });

  it("falls back to undefined model when nothing is stamped or started", () => {
    const state = createStreamingState();
    const result = processSdkMessage(
      {
        type: "stream_event",
        session_id: "thread",
        event: {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "Hi" },
        },
      },
      state,
    );

    expect(result.mutations[0].block.model).toBeUndefined();
  });
});

describe("processSdkMessage – subagent completion transitions", () => {
  type StreamState = ReturnType<typeof createStreamingState>;

  function streamEvent(
    state: StreamState,
    parentToolUseId: string | null,
    event: Record<string, unknown>,
  ): void {
    processSdkMessage(
      {
        type: "stream_event",
        session_id: "s1",
        ...(parentToolUseId ? { parent_tool_use_id: parentToolUseId } : {}),
        event,
      },
      state,
    );
  }

  function startAgent(state: StreamState): void {
    streamEvent(state, null, {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "toolu_task", name: "Agent", input: {} },
    });
  }

  it("does not complete a Task when its own input_json_delta streams at root", () => {
    const state = createStreamingState();
    startAgent(state);
    // A subagent child begins → stream context switches to the Task.
    streamEvent(state, "toolu_task", {
      type: "content_block_start",
      index: 1,
      content_block: { type: "text", text: "working" },
    });
    // The Task's own args (title/description) finish streaming at root.
    streamEvent(state, null, {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: '{"description":"Run lint"}' },
    });
    expect(state.toolUseIdToBlock.get("toolu_task")?.taskComplete).not.toBe(true);
  });

  it("completes a Task when the main agent resumes with a new root block", () => {
    const state = createStreamingState();
    startAgent(state);
    streamEvent(state, "toolu_task", {
      type: "content_block_start",
      index: 1,
      content_block: { type: "text", text: "working" },
    });
    // Main agent resumes at root with a fresh block → the subagent is done.
    streamEvent(state, null, {
      type: "content_block_start",
      index: 2,
      content_block: { type: "text", text: "Done" },
    });
    expect(state.toolUseIdToBlock.get("toolu_task")?.taskComplete).toBe(true);
  });

  it("completes a Task when the main agent resumes via message_start", () => {
    const state = createStreamingState();
    startAgent(state);
    // Subagent speaks (its own message opens under the Task's id).
    streamEvent(state, "toolu_task", { type: "message_start", message: {} });
    // Main agent resumes — a fresh message at root, no content_block_start yet.
    streamEvent(state, null, { type: "message_start", message: {} });
    expect(state.toolUseIdToBlock.get("toolu_task")?.taskComplete).toBe(true);
  });

  it("does not complete a background Task when the main agent resumes", () => {
    const state = createStreamingState();
    startAgent(state);
    // The launch ack flagged this subagent as running in the background.
    const task = state.toolUseIdToBlock.get("toolu_task");
    if (task) task.taskBackground = true;
    streamEvent(state, "toolu_task", {
      type: "content_block_start",
      index: 1,
      content_block: { type: "text", text: "working" },
    });
    // Main agent interleaves — a background subagent keeps running.
    streamEvent(state, null, { type: "message_start", message: {} });
    expect(state.toolUseIdToBlock.get("toolu_task")?.taskComplete).not.toBe(true);
  });
});
