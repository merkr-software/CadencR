import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const rewindToMessage = vi.fn();
const forkFromMessage = vi.fn();
const sendPrompt = vi.fn();
const copyAs = vi.fn(() => Promise.resolve());
const mocks = vi.hoisted(() => ({ phone: true }));

vi.mock("@/hooks/useIsMobile", () => ({ useIsMobile: () => mocks.phone }));
vi.mock("@/hooks/useIsTouchDevice", () => ({ useIsTouchDevice: () => mocks.phone }));
vi.mock("@/stores/ws-session-store", () => ({
  useWsSessionStore: (selector: (s: unknown) => unknown) =>
    selector({ rewindToMessage, forkFromMessage, sendPrompt }),
}));
vi.mock("@/lib/markdown-export", () => ({
  copyAs: (...args: unknown[]) => copyAs(...(args as [])),
}));
vi.mock("@/lib/email-export", () => ({ rangeToEmailHtml: () => "<p>hello</p>" }));
vi.mock("@/hooks/useStreamingMarkdownThrottle", () => ({
  useStreamingMarkdownThrottle: (content: string) => content,
}));
vi.mock("@/components/Markdown", () => ({
  Markdown: ({ content }: { content: string }) => <p>{content}</p>,
}));

import type { AgentBlockData } from "@/types/agent-block";
import { TextBlock } from "../AgentTextBlocks";
import { AgentSessionProvider } from "./agent-session-context";
import { UserMessageActions } from "./UserMessageActions";

const NOOP_ACTIONS = { featureId: 1, sendPrompt: vi.fn(), openModelPicker: vi.fn() };
const persisted: AgentBlockData = { id: "msg-42", type: "user_message", content: "hello" };

function renderUserActions(block: AgentBlockData = persisted) {
  return render(
    <AgentSessionProvider value={{ wsSessionId: "ws-feature-1", ...NOOP_ACTIONS }}>
      <UserMessageActions block={block} bubbleRef={{ current: null }} />
    </AgentSessionProvider>,
  );
}

async function openSheet(): Promise<HTMLElement> {
  await userEvent.click(screen.getByRole("button", { name: "Message actions" }));
  return screen.findByRole("dialog", { name: "Message actions" });
}

describe("message actions on phone", () => {
  beforeEach(() => {
    mocks.phone = true;
    rewindToMessage.mockClear();
    forkFromMessage.mockClear();
    copyAs.mockClear();
  });

  it("shows one … control under a prompt instead of the row of text buttons", () => {
    renderUserActions();
    expect(screen.getByRole("button", { name: "Message actions" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^copy/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /fork/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /rewind/i })).toBeNull();
    // The sheet mounts only when opened.
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("gives the … control a 44px box that reaches down, never up over the message", () => {
    renderUserActions();
    const trigger = screen.getByRole("button", { name: "Message actions" });
    expect(trigger).toHaveClass("size-11", "-mb-5", "items-start");
    expect(trigger.className).not.toMatch(/-my-|-mt-/);
  });

  it("lists Copy, the other Copy as formats, Fork and Rewind as 44px rows", async () => {
    renderUserActions();
    const sheet = await openSheet();
    const rows = within(sheet)
      .getAllByRole("button")
      .map((row) => row.textContent);
    expect(rows).toEqual(["Copy", "Slack mrkdwn", "Plain text", "Email", "Fork", "Rewind"]);
    for (const row of within(sheet).getAllByRole("button")) expect(row).toHaveClass("min-h-11");
  });

  it("runs the desktop row's handlers", async () => {
    renderUserActions();
    await userEvent.click(within(await openSheet()).getByRole("button", { name: "Copy" }));
    expect(copyAs).toHaveBeenCalledWith("markdown", "hello", undefined);

    await userEvent.click(within(await openSheet()).getByRole("button", { name: "Slack mrkdwn" }));
    expect(copyAs).toHaveBeenCalledWith("slack", "hello", undefined);

    await userEvent.click(within(await openSheet()).getByRole("button", { name: "Fork" }));
    expect(forkFromMessage).toHaveBeenCalledWith("ws-feature-1", 42);

    await userEvent.click(within(await openSheet()).getByRole("button", { name: "Rewind" }));
    expect(rewindToMessage).toHaveBeenCalledWith("ws-feature-1", 42);
  });

  it("leaves Fork and Rewind out for a message that cannot branch", async () => {
    renderUserActions({ id: "synthetic-user", type: "user_message", content: "live" });
    const sheet = await openSheet();
    expect(within(sheet).queryByRole("button", { name: "Fork" })).toBeNull();
    expect(within(sheet).getByRole("button", { name: "Copy" })).toBeInTheDocument();
  });

  it("offers Retry for an undelivered prompt", async () => {
    renderUserActions({
      ...persisted,
      messageUuid: "a48cc11a-8a72-47f7-8577-d5c533d7909c",
      promptDeliveryState: "delivery_failed",
    });
    await userEvent.click(within(await openSheet()).getByRole("button", { name: "Retry" }));
    expect(sendPrompt).toHaveBeenCalledWith("ws-feature-1", "hello", {
      messageUuid: "a48cc11a-8a72-47f7-8577-d5c533d7909c",
    });
  });

  it("gives a reply the same … with Copy only while it streams", async () => {
    const { rerender } = render(<TextBlock content="**reply**" isStreaming />);
    let sheet = await openSheet();
    expect(
      within(sheet)
        .getAllByRole("button")
        .map((row) => row.textContent),
    ).toEqual(["Copy"]);
    await userEvent.click(within(sheet).getByRole("button", { name: "Copy" }));
    expect(copyAs).toHaveBeenCalledWith("markdown", "**reply**", undefined);

    // Deltas reach the copy without re-rendering the control.
    rerender(<TextBlock content="**reply** grows" isStreaming />);
    await userEvent.click(within(await openSheet()).getByRole("button", { name: "Copy" }));
    expect(copyAs).toHaveBeenLastCalledWith("markdown", "**reply** grows", undefined);

    rerender(<TextBlock content="**reply**" />);
    sheet = await openSheet();
    expect(within(sheet).getByRole("button", { name: "Plain text" })).toBeInTheDocument();
  });
});

describe("message actions on desktop", () => {
  beforeEach(() => {
    mocks.phone = false;
  });

  it("keeps the row of text buttons and no … control", () => {
    renderUserActions();
    expect(screen.queryByRole("button", { name: "Message actions" })).toBeNull();
    expect(screen.getByRole("button", { name: /copy/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /fork/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /rewind/i })).toBeInTheDocument();
  });

  it("keeps a reply's Copy button", () => {
    render(<TextBlock content="reply" />);
    expect(screen.queryByRole("button", { name: "Message actions" })).toBeNull();
    expect(screen.getByRole("button", { name: /copy/i })).toBeInTheDocument();
  });
});
