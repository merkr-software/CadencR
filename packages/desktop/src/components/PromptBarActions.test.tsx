import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@/test-utils";
import { PromptBarActions } from "./PromptBarActions";

const base = {
  onAddFiles: vi.fn(),
  inputsDisabled: false,
  onStop: vi.fn(),
  onSend: vi.fn(),
  canSend: true,
  sending: false,
  showSendButton: true,
};

describe("PromptBarActions", () => {
  it("sends when idle", () => {
    render(<PromptBarActions {...base} isRunning={false} />);
    expect(screen.getByRole("button", { name: "Send message" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Stop agent" })).not.toBeInTheDocument();
  });

  it("steers beside a square Stop while the agent works", async () => {
    const onSend = vi.fn();
    const { user } = render(<PromptBarActions {...base} isRunning onSend={onSend} />);
    expect(screen.getByRole("button", { name: "Stop agent" })).toHaveTextContent("Stop");
    await user.click(screen.getByRole("button", { name: "Steer the agent with this message" }));
    expect(onSend).toHaveBeenCalled();
  });

  it("queues instead when the provider can't take mid-turn prompts", async () => {
    const onQueue = vi.fn();
    const onSend = vi.fn();
    const { user } = render(
      <PromptBarActions {...base} isRunning onSend={onSend} onQueue={onQueue} queuesOnEnter />,
    );
    await user.click(screen.getByRole("button", { name: "Queue this message for after the turn" }));
    expect(onQueue).toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();
  });
});
