import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { buildUserMessageContent } from "@/types/agent-types";
import { UserMessageBlock } from "./UserMessageBlock";

describe("UserMessageBlock", () => {
  it("uses provider-neutral copy for pending receipt state", () => {
    render(<UserMessageBlock content="steer now" deliveryState="pending_agent" />);

    expect(screen.getByText("Not received by agent yet…")).toBeInTheDocument();
    expect(screen.queryByText(/OpenCode/)).toBeNull();
  });

  it("visually distinguishes pending prompt delivery", () => {
    render(<UserMessageBlock content="steer now" deliveryState="pending_agent" />);

    const bubble = screen.getByTestId("user-message-bubble");
    expect(bubble).toHaveAttribute("data-prompt-delivery-state", "pending_agent");
    expect(bubble).toHaveClass("border-amber-500/50", "bg-amber-500/10");
    expect(screen.getByText("Not received by agent yet…")).toHaveClass("text-amber-300");
  });

  it("shows a terminal unknown receipt without a permanent pending spinner", () => {
    render(<UserMessageBlock content="steer now" deliveryState="delivery_unknown" />);

    expect(screen.getByText("Agent receipt could not be confirmed")).toBeInTheDocument();
    expect(screen.queryByText("Not received by agent yet…")).not.toBeInTheDocument();
    expect(screen.getByTestId("user-message-bubble")).toHaveAttribute(
      "data-prompt-delivery-state",
      "delivery_unknown",
    );
  });

  it("shows a failed provider delivery explicitly", () => {
    render(<UserMessageBlock content="steer now" deliveryState="delivery_failed" />);

    expect(screen.getByText("Message was not delivered to the agent")).toBeInTheDocument();
    expect(screen.getByTestId("user-message-bubble")).toHaveClass(
      "border-destructive/50",
      "bg-destructive/10",
    );
  });

  it("sets the sender tab above the bubble", () => {
    render(<UserMessageBlock content="relance les gates" senderTab={<span>From an agent</span>} />);

    const tab = screen.getByTestId("user-message-sender-tab");
    expect(tab).toHaveTextContent("From an agent");
    expect(tab.nextElementSibling).toBe(screen.getByTestId("user-message-bubble"));
  });

  it("renders no tab for a message the person typed", () => {
    render(<UserMessageBlock content="hello" />);

    expect(screen.queryByTestId("user-message-sender-tab")).toBeNull();
  });

  it("renders non-image attachment filenames instead of image previews", () => {
    const content = buildUserMessageContent("review this", [
      {
        base64: "JVBERi0x",
        fileName: "requirements.pdf",
        kind: "document",
        mimeType: "application/pdf",
      },
    ]);

    render(<UserMessageBlock content={content} />);

    expect(screen.getByText("requirements.pdf")).toBeInTheDocument();
    expect(screen.queryByRole("img")).toBeNull();
  });
});
