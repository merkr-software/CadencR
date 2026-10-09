import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";

const rewindToMessage = vi.fn();
const forkFromMessage = vi.fn();
const sendPrompt = vi.fn();
const copyAs = vi.fn();
const toastError = vi.fn();

vi.mock("@/stores/ws-session-store", () => ({
  useWsSessionStore: (selector: (s: unknown) => unknown) =>
    selector({ rewindToMessage, forkFromMessage, sendPrompt }),
}));
vi.mock("@/lib/markdown-export", () => ({
  copyAs: (...args: unknown[]) => copyAs(...args),
}));
const useIsTouchDevice = vi.hoisted(() => vi.fn(() => false));
vi.mock("@/hooks/useIsTouchDevice", () => ({ useIsTouchDevice }));
const rangeToEmailHtml = vi.hoisted(() => vi.fn((_range: Range) => "<p>hello</p>"));
vi.mock("@/lib/email-export", () => ({ rangeToEmailHtml }));
vi.mock("sonner", () => ({
  toast: { error: (...args: unknown[]) => toastError(...args) },
}));
import { extractPromptBlobs, resetPromptBlobCacheForTest } from "@/lib/prompt-image-cache";
import type { AgentBlockData } from "../AgentBlock";
import { AgentSessionProvider } from "./agent-session-context";
import { UserMessageActions } from "./UserMessageActions";
import { UserMessageBlock } from "../UserMessageBlock";

function renderActions(block: AgentBlockData, wsSessionId: string | null = "ws-feature-1") {
  return render(
    <AgentSessionProvider value={{ wsSessionId }}>
      <UserMessageActions block={block} bubbleRef={{ current: null }} />
    </AgentSessionProvider>,
  );
}

const persisted: AgentBlockData = { id: "msg-42", type: "user_message", content: "hello" };

describe("UserMessageActions", () => {
  beforeEach(() => {
    useIsTouchDevice.mockReturnValue(false);
    rewindToMessage.mockClear();
    forkFromMessage.mockClear();
    sendPrompt.mockClear();
    copyAs.mockClear();
    toastError.mockClear();
  });
  afterEach(() => resetPromptBlobCacheForTest());

  it("copies the message as markdown", async () => {
    renderActions(persisted);
    await userEvent.click(screen.getByRole("button", { name: /copy/i }));
    expect(copyAs).toHaveBeenCalledWith("markdown", "hello");
  });

  it("dispatches fork and rewind for a persisted user message in a live session", async () => {
    renderActions(persisted);
    await userEvent.click(screen.getByRole("button", { name: /fork/i }));
    await userEvent.click(screen.getByRole("button", { name: /rewind/i }));
    expect(forkFromMessage).toHaveBeenCalledWith("ws-feature-1", 42);
    expect(rewindToMessage).toHaveBeenCalledWith("ws-feature-1", 42);
  });

  it("resolves the DB id from an explicit canonical cursor", async () => {
    renderActions({ id: "canonical-user", type: "user_message", content: "live", messageDbId: 99 });
    await userEvent.click(screen.getByRole("button", { name: /rewind/i }));
    expect(rewindToMessage).toHaveBeenCalledWith("ws-feature-1", 99);
  });

  it("hides fork/rewind for a non-persisted synthetic block", () => {
    renderActions({ id: "synthetic-user", type: "user_message", content: "live" });
    expect(screen.queryByRole("button", { name: /fork/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /rewind/i })).toBeNull();
    expect(screen.getByRole("button", { name: /copy/i })).toBeInTheDocument();
  });

  it("hides fork/rewind when there is no live session", () => {
    renderActions(persisted, null);
    expect(screen.queryByRole("button", { name: /fork/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /rewind/i })).toBeNull();
  });

  it("retries plain text with the same canonical UUID", async () => {
    renderActions({
      ...persisted,
      messageUuid: "a48cc11a-8a72-47f7-8577-d5c533d7909c",
      promptDeliveryState: "delivery_failed",
    });

    await userEvent.click(screen.getByRole("button", { name: /retry/i }));

    expect(sendPrompt).toHaveBeenCalledWith("ws-feature-1", "hello", {
      messageUuid: "a48cc11a-8a72-47f7-8577-d5c533d7909c",
    });
    expect(screen.getByRole("button", { name: /retrying/i })).toBeDisabled();
  });

  it("retries persisted images as prompt attachments instead of JSON text", async () => {
    const content = JSON.stringify([
      { type: "text", text: "inspect" },
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "aW1hZ2U=" },
      },
    ]);
    renderActions({
      ...persisted,
      content,
      messageUuid: "a48cc11a-8a72-47f7-8577-d5c533d7909c",
      promptDeliveryState: "delivery_unknown",
    });

    await userEvent.click(screen.getByRole("button", { name: /retry/i }));

    expect(sendPrompt).toHaveBeenCalledWith("ws-feature-1", "inspect", {
      messageUuid: "a48cc11a-8a72-47f7-8577-d5c533d7909c",
      attachments: [
        { base64: "aW1hZ2U=", fileName: "image", kind: "image", mimeType: "image/png" },
      ],
    });
  });

  it("disables retry when persisted attachment bytes are unavailable", async () => {
    const content = JSON.stringify([
      { type: "text", text: "inspect" },
      {
        type: "attachment",
        file_name: "brief.pdf",
        kind: "document",
        media_type: "application/pdf",
      },
    ]);
    renderActions({
      ...persisted,
      content,
      messageUuid: "a48cc11a-8a72-47f7-8577-d5c533d7909c",
      promptDeliveryState: "delivery_failed",
    });

    const retry = screen.getByRole("button", { name: /retry/i });
    expect(retry).toBeDisabled();
    await userEvent.click(retry);
    expect(sendPrompt).not.toHaveBeenCalled();
  });

  it("rebuilds an off-loaded payload from the blob cache", async () => {
    const stashed = extractPromptBlobs(
      JSON.stringify([
        { type: "text", text: "inspect" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "aW1hZ2U=" } },
      ]),
    );
    renderActions({
      ...persisted,
      content: stashed,
      messageUuid: "a48cc11a-8a72-47f7-8577-d5c533d7909c",
      promptDeliveryState: "delivery_unknown",
    });

    await userEvent.click(screen.getByRole("button", { name: /retry/i }));

    await waitFor(() =>
      expect(sendPrompt).toHaveBeenCalledWith("ws-feature-1", "inspect", {
        messageUuid: "a48cc11a-8a72-47f7-8577-d5c533d7909c",
        attachments: [
          { base64: "aW1hZ2U=", fileName: "image", kind: "image", mimeType: "image/png" },
        ],
      }),
    );
  });

  // Re-sending the prompt with its screenshot quietly missing is worse than not
  // re-sending it: the agent would answer a question about an image it can't see.
  it("reports the failure instead of resending a message without its evicted image", async () => {
    const stashed = extractPromptBlobs(
      JSON.stringify([
        { type: "text", text: "inspect" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "aW1hZ2U=" } },
      ]),
    );
    resetPromptBlobCacheForTest();
    renderActions({
      ...persisted,
      content: stashed,
      messageUuid: "a48cc11a-8a72-47f7-8577-d5c533d7909c",
      promptDeliveryState: "delivery_unknown",
    });

    await userEvent.click(screen.getByRole("button", { name: /retry/i }));

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        "Couldn't resend this message",
        expect.objectContaining({
          description: expect.stringContaining("no longer held in memory"),
        }),
      ),
    );
    expect(sendPrompt).not.toHaveBeenCalled();
  });

  it("emails the rendered bubble from the touch Copy as menu", async () => {
    useIsTouchDevice.mockReturnValue(true);
    const user = userEvent.setup();
    render(
      <AgentSessionProvider value={{ wsSessionId: "ws-feature-1" }}>
        <UserMessageBlock
          content="hello"
          renderActions={(bubbleRef) => (
            <UserMessageActions block={persisted} bubbleRef={bubbleRef} />
          )}
        />
      </AgentSessionProvider>,
    );

    await user.click(screen.getByRole("button", { name: /Copy as/ }));
    await user.click(await screen.findByRole("menuitem", { name: "Email" }));

    expect(rangeToEmailHtml.mock.calls[0]?.[0].commonAncestorContainer).toBe(
      screen.getByTestId("user-message-bubble"),
    );
    expect(copyAs).toHaveBeenCalledWith("email", "hello", "<p>hello</p>");
  });
});
