import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@/test-utils";
import { ComposerContextProvider, type ComposerContextValue } from "./ComposerContext";
import { QueueRail } from "./QueueRail";

const queue = {
  available: true,
  busy: false,
  items: [
    { id: 1, session_id: 9, content: "Then run the tests", status: "pending", created_at: "" },
    {
      id: 2,
      session_id: 9,
      content: "Open a PR",
      status: "error",
      error: "agent offline",
      created_at: "",
    },
  ],
  enqueue: vi.fn(),
  update: vi.fn(() => Promise.resolve()),
  remove: vi.fn(() => Promise.resolve()),
  sendNow: vi.fn(() => Promise.resolve()),
};
vi.mock("./usePromptQueue", () => ({ usePromptQueue: () => queue }));

function renderRail(isRunning: boolean) {
  const value = { sessionId: 9, isRunning } as unknown as ComposerContextValue;
  return render(
    <ComposerContextProvider value={value}>
      <QueueRail />
    </ComposerContextProvider>,
  );
}

describe("QueueRail", () => {
  it("lists queued prompts with when they go out, and surfaces a failed delivery", () => {
    renderRail(true);
    expect(screen.getByRole("region", { name: "Queued messages" })).toHaveTextContent(
      "Sends when the agent finishes this turn",
    );
    expect(screen.getByText("Then run the tests")).toBeInTheDocument();
    expect(screen.getByText(/Not delivered: agent offline/)).toBeInTheDocument();
  });

  it("sends now, removes, and edits a queued prompt", async () => {
    const { user } = renderRail(false);
    expect(screen.getByText(/Held: sends after the next turn/)).toBeInTheDocument();
    await user.click(screen.getAllByRole("button", { name: "Send now" })[0]);
    expect(queue.sendNow).toHaveBeenCalledWith(1);
    await user.click(screen.getAllByRole("button", { name: "Remove" })[0]);
    expect(queue.remove).toHaveBeenCalledWith(1);
    await user.click(screen.getAllByRole("button", { name: "Edit" })[0]);
    const field = screen.getByRole("textbox", { name: "Edit queued message" });
    await user.clear(field);
    await user.type(field, "Run the unit tests{Enter}");
    expect(queue.update).toHaveBeenCalledWith(1, "Run the unit tests");
  });
});
