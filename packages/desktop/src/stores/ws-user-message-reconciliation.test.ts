import { afterEach, describe, expect, it } from "vitest";
import type { AgentBlockData } from "@/types/agent-block";
import { promptImageSrc, resetPromptBlobCacheForTest } from "@/lib/prompt-image-cache";
import { buildUserMessageContent, parseUserMessageContent } from "@/types/agent-types";
import {
  canonicalUserMessageBlock,
  mergeCanonicalBlocks,
  upsertCanonicalUserMessage,
  type CanonicalUserMessage,
} from "./ws-user-message-reconciliation";

function message(overrides: Partial<CanonicalUserMessage> = {}): CanonicalUserMessage {
  return {
    messageId: 42,
    messageUuid: "a48cc11a-8a72-47f7-8577-d5c533d7909c",
    text: "hello",
    createdAt: "2026-07-12T20:00:00Z",
    ...overrides,
  };
}

function block(id: string, type: AgentBlockData["type"] = "text"): AgentBlockData {
  return { id, type, content: id };
}

describe("canonical user-message content budget", () => {
  afterEach(() => resetPromptBlobCacheForTest());

  // `processSdkMessage` never emits a `user_message`, so this builder is the
  // only producer on the live path. Without the budget here a just-sent
  // screenshot prompt stayed inline in the store for the whole session and was
  // only off-loaded on the next hydration.
  it("off-loads an image payload the moment the message is echoed back", () => {
    const text = buildUserMessageContent("look at this", [
      { base64: "A".repeat(400_000), fileName: "shot.png", kind: "image", mimeType: "image/png" },
    ]);

    const built = canonicalUserMessageBlock(message({ text }));

    expect(built.content.length).toBeLessThan(1000);
    const parsed = parseUserMessageContent(built.content);
    expect(parsed.text).toBe("look at this");
    expect(promptImageSrc(parsed.images[0])).toMatch(/^blob:/);
  });

  it("leaves an ordinary text prompt untouched", () => {
    expect(canonicalUserMessageBlock(message({ text: "just words" })).content).toBe("just words");
  });
});

describe("canonical user-message reconciliation", () => {
  it("upserts a repeated canonical event instead of appending a duplicate", () => {
    const once = upsertCanonicalUserMessage([], message());
    const twice = upsertCanonicalUserMessage(once, message());

    expect(twice).toBe(once);
    expect(twice).toHaveLength(1);
    expect(twice[0].id).toBe("msg-42");
  });

  it("reconciles a canonical event with the same UUID even if the local key differs", () => {
    const existing: AgentBlockData = {
      id: "local-pending-message",
      type: "user_message",
      content: "hello",
      messageUuid: message().messageUuid,
      promptDeliveryState: "pending_agent",
    };

    const reconciled = upsertCanonicalUserMessage([existing], {
      ...message(),
      promptDeliveryState: "pending_agent",
    });

    expect(reconciled).toHaveLength(1);
    expect(reconciled[0]).toMatchObject({
      id: "msg-42",
      messageDbId: 42,
      messageUuid: message().messageUuid,
    });
  });

  it("deduplicates a live sender event against the following REST snapshot", () => {
    const live = canonicalUserMessageBlock(message());
    const snapshot = canonicalUserMessageBlock(message());

    const merged = mergeCanonicalBlocks([live], [snapshot]);

    expect(merged).toHaveLength(1);
    expect(merged[0].messageUuid).toBe(message().messageUuid);
  });

  it("deduplicates a passive-viewer event against reconnect resync", () => {
    const mirrored = canonicalUserMessageBlock(message({ messageId: 51 }));
    const resynced = {
      ...canonicalUserMessageBlock(message({ messageId: 51 })),
      id: "msg-51",
    };

    const merged = mergeCanonicalBlocks([block("msg-50"), mirrored], [resynced]);

    expect(merged.map((item) => item.id)).toEqual(["msg-50", "msg-51"]);
  });

  it("deduplicates pagination overlap by DB id for legacy rows without UUID", () => {
    const existing = [block("msg-10"), block("msg-11")];
    const olderPage = [block("msg-9"), block("msg-10")];

    const merged = mergeCanonicalBlocks(existing, olderPage);

    expect(merged.map((item) => item.id)).toEqual(["msg-9", "msg-10", "msg-11"]);
  });

  it("grafts paginated children into an already-held parent without overwriting it", () => {
    const heldParent = {
      ...block("msg-10", "tool_call"),
      content: "live parent content",
      childBlocks: [block("msg-11")],
    };
    const pageParent = {
      ...block("msg-10", "tool_call"),
      content: "stale snapshot content",
      childBlocks: [block("msg-11"), block("msg-12"), block("msg-13")],
    };

    const merged = mergeCanonicalBlocks([heldParent], [pageParent]);

    expect(merged[0].content).toBe("live parent content");
    expect(merged[0].childBlocks?.map((child) => child.id)).toEqual(["msg-11", "msg-12", "msg-13"]);
  });

  it("recursively grafts a cross-page grandchild beneath both held ancestors", () => {
    const held = {
      ...block("msg-1", "tool_call"),
      childBlocks: [{ ...block("msg-2", "tool_call"), childBlocks: [block("msg-3")] }],
    };
    const page = {
      ...block("msg-1", "tool_call"),
      childBlocks: [
        {
          ...block("msg-2", "tool_call"),
          childBlocks: [block("msg-3"), block("msg-44")],
        },
      ],
    };

    const merged = mergeCanonicalBlocks([held], [page]);

    expect(merged).toHaveLength(1);
    expect(merged[0].childBlocks).toHaveLength(1);
    expect(merged[0].childBlocks?.[0].childBlocks?.map((child) => child.id)).toEqual([
      "msg-3",
      "msg-44",
    ]);
  });

  it("adds a result-derived patch to a held file-change call without replacing its args", () => {
    const held = {
      ...block("msg-40", "tool_call"),
      toolName: "ApplyPatch",
      content: '{"path":"src/a.ts"}',
      toolArgs: '{"path":"src/a.ts"}',
    };
    const enriched = {
      ...held,
      content: '{"path":"src/a.ts","patch_text":"*** Begin Patch\\n+line"}',
      toolArgs: '{"path":"src/a.ts","patch_text":"*** Begin Patch\\n+line"}',
    };

    const merged = mergeCanonicalBlocks([held], [enriched]);

    expect(JSON.parse(merged[0].content)).toEqual({
      path: "src/a.ts",
      patch_text: "*** Begin Patch\n+line",
    });
    expect(JSON.parse(merged[0].toolArgs ?? "")).toEqual({
      path: "src/a.ts",
      patch_text: "*** Begin Patch\n+line",
    });
  });

  it("keeps an existing full patch unflagged when incoming enrichment is truncated", () => {
    const held = {
      ...block("msg-40", "tool_call"),
      toolName: "ApplyPatch",
      content: '{"path":"src/a.ts","patch_text":"complete"}',
      toolArgs: '{"path":"src/a.ts","patch_text":"complete"}',
    };
    const merged = mergeCanonicalBlocks(
      [held],
      [{ ...held, content: '{"patch_text":"partial"}', truncatedContent: true }],
    );

    expect(merged[0].content).toBe(held.content);
    expect(merged[0].truncatedContent).toBeUndefined();
  });

  it("flags missing patch content when the only incoming enrichment is truncated", () => {
    const held = {
      ...block("msg-40", "tool_call"),
      toolName: "ApplyPatch",
      content: '{"path":"src/a.ts"}',
      toolArgs: '{"path":"src/a.ts"}',
    };
    const merged = mergeCanonicalBlocks(
      [held],
      [{ ...held, content: '{"patch_text":"partial"}', truncatedContent: true }],
    );

    expect(merged[0].content).toBe(held.content);
    expect(merged[0].toolArgs).toBe(held.toolArgs);
    expect(merged[0].truncatedContent).toBe(true);
  });

  it("inserts a recovered message at its database position", () => {
    const merged = upsertCanonicalUserMessage(
      [block("msg-41"), block("msg-43")],
      message({ messageId: 42 }),
    );

    expect(merged.map((item) => item.id)).toEqual(["msg-41", "msg-42", "msg-43"]);
  });

  it("keeps pending canonical messages behind later persisted blocks", () => {
    const merged = upsertCanonicalUserMessage(
      [block("msg-41"), block("msg-43")],
      message({ messageId: 42, promptDeliveryState: "pending_agent" }),
    );

    expect(merged.map((item) => item.id)).toEqual(["msg-41", "msg-43", "msg-42"]);
  });

  it("orders and deduplicates a recovered batch in one merge", () => {
    const recovered = canonicalUserMessageBlock(message({ messageId: 42 }));
    const merged = mergeCanonicalBlocks(
      [block("msg-40"), block("msg-43")],
      [block("msg-41"), recovered, { ...recovered }],
    );

    expect(merged.map((item) => item.id)).toEqual(["msg-40", "msg-41", "msg-42", "msg-43"]);
  });

  it("does not regress a received receipt when a pending event is replayed", () => {
    const received = canonicalUserMessageBlock({
      ...message(),
      promptDeliveryState: "received_agent",
    });
    const replayed = upsertCanonicalUserMessage([received], {
      ...message(),
      promptDeliveryState: "pending_agent",
    });

    expect(replayed[0].promptDeliveryState).toBe("received_agent");
  });
});
