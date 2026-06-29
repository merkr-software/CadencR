import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach } from "vitest";

const rewindToMessage = vi.fn();
const forkFromMessage = vi.fn();
const copyAs = vi.fn();

vi.mock("@/stores/ws-session-store", () => ({
  useWsSessionStore: (selector: (s: unknown) => unknown) =>
    selector({ rewindToMessage, forkFromMessage }),
}));
vi.mock("@/lib/markdown-export", () => ({
  copyAs: (...args: unknown[]) => copyAs(...args),
}));
vi.mock("@/components/AgentBlock", () => ({
  messageIdFromBlockId: (id: string) => (id.startsWith("msg-") ? Number(id.slice(4)) : undefined),
}));

import type { AgentBlockData } from "../AgentBlock";
import { AgentSessionProvider } from "./agent-session-context";
import { UserMessageActions } from "./UserMessageActions";

function renderActions(block: AgentBlockData, wsSessionId: string | null = "ws-feature-1") {
  return render(
    <AgentSessionProvider value={{ wsSessionId }}>
      <UserMessageActions block={block} />
    </AgentSessionProvider>,
  );
}

const persisted: AgentBlockData = { id: "msg-42", type: "user_message", content: "hello" };

describe("UserMessageActions", () => {
  beforeEach(() => {
    rewindToMessage.mockClear();
    forkFromMessage.mockClear();
    copyAs.mockClear();
  });

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

  it("resolves the DB id from a stamped live block (ws-user-*)", async () => {
    renderActions({ id: "ws-user-3", type: "user_message", content: "live", messageDbId: 99 });
    await userEvent.click(screen.getByRole("button", { name: /rewind/i }));
    expect(rewindToMessage).toHaveBeenCalledWith("ws-feature-1", 99);
  });

  it("hides fork/rewind for an unstamped live block", () => {
    renderActions({ id: "ws-user-3", type: "user_message", content: "live" });
    expect(screen.queryByRole("button", { name: /fork/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /rewind/i })).toBeNull();
    expect(screen.getByRole("button", { name: /copy/i })).toBeInTheDocument();
  });

  it("hides fork/rewind when there is no live session", () => {
    renderActions(persisted, null);
    expect(screen.queryByRole("button", { name: /fork/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /rewind/i })).toBeNull();
  });
});
