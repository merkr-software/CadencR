import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@/test-utils";
import { PlanApprovalBar } from "./PlanApprovalBar";

describe("PlanApprovalBar", () => {
  it("renders plan ready heading", () => {
    render(<PlanApprovalBar onApprove={vi.fn()} onRequestChanges={vi.fn()} />);
    expect(screen.getByText("Plan ready for review")).toBeInTheDocument();
  });

  it("renders approve button", () => {
    render(<PlanApprovalBar onApprove={vi.fn()} onRequestChanges={vi.fn()} />);
    expect(screen.getByRole("button", { name: /approve & execute/i })).toBeInTheDocument();
  });

  it("renders custom approveLabel", () => {
    render(
      <PlanApprovalBar approveLabel="Execute Now" onApprove={vi.fn()} onRequestChanges={vi.fn()} />,
    );
    expect(screen.getByRole("button", { name: /execute now/i })).toBeInTheDocument();
  });

  it("calls onApprove when approve clicked", async () => {
    const onApprove = vi.fn();
    const { user } = render(<PlanApprovalBar onApprove={onApprove} onRequestChanges={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: /approve/i }));
    expect(onApprove).toHaveBeenCalledOnce();
  });

  it("shows feedback textarea after request changes click", async () => {
    const { user } = render(<PlanApprovalBar onApprove={vi.fn()} onRequestChanges={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: /request changes/i }));
    expect(screen.getByPlaceholderText(/describe the changes/i)).toBeInTheDocument();
  });

  it("calls onRequestChanges with feedback text", async () => {
    const onRequestChanges = vi.fn();
    const { user } = render(
      <PlanApprovalBar onApprove={vi.fn()} onRequestChanges={onRequestChanges} />,
    );
    await user.click(screen.getByRole("button", { name: /request changes/i }));
    await user.type(screen.getByPlaceholderText(/describe the changes/i), "Need more tests");
    await user.click(screen.getByRole("button", { name: "" })); // send button (icon only)
    expect(onRequestChanges).toHaveBeenCalledWith("Need more tests");
  });

  it("prefills request changes with the latest prompt text", async () => {
    const { user } = render(
      <PlanApprovalBar
        initialFeedback="Use the original prompt as context"
        onApprove={vi.fn()}
        onRequestChanges={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: /request changes/i }));

    expect(screen.getByPlaceholderText(/describe the changes/i)).toHaveValue(
      "Use the original prompt as context",
    );
  });

  it("submits the prefilled feedback without retyping", async () => {
    const onRequestChanges = vi.fn();
    const { user } = render(
      <PlanApprovalBar
        initialFeedback="Tighten the scope"
        onApprove={vi.fn()}
        onRequestChanges={onRequestChanges}
      />,
    );

    await user.click(screen.getByRole("button", { name: /request changes/i }));
    await user.click(screen.getByRole("button", { name: "" }));

    expect(onRequestChanges).toHaveBeenCalledWith("Tighten the scope");
  });

  it("renders reject & stop button when onReject is provided", () => {
    render(<PlanApprovalBar onApprove={vi.fn()} onRequestChanges={vi.fn()} onReject={vi.fn()} />);
    expect(screen.getByRole("button", { name: /reject & stop/i })).toBeInTheDocument();
  });

  it("does not render reject & stop button when onReject is not provided", () => {
    render(<PlanApprovalBar onApprove={vi.fn()} onRequestChanges={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /reject & stop/i })).not.toBeInTheDocument();
  });

  it("calls onReject when reject & stop clicked", async () => {
    const onReject = vi.fn();
    const { user } = render(
      <PlanApprovalBar onApprove={vi.fn()} onRequestChanges={vi.fn()} onReject={onReject} />,
    );
    await user.click(screen.getByRole("button", { name: /reject & stop/i }));
    expect(onReject).toHaveBeenCalledOnce();
  });

  it("Escape in the feedback field closes the field and keeps the plan", async () => {
    const onReject = vi.fn();
    const { user } = render(
      <PlanApprovalBar onApprove={vi.fn()} onRequestChanges={vi.fn()} onReject={onReject} />,
    );
    await user.click(screen.getByRole("button", { name: /request changes/i }));
    const field = screen.getByPlaceholderText(/describe the changes/i);
    await user.type(field, "shorter please");

    fireEvent.keyDown(window, { key: "Escape", code: "Escape" });
    fireEvent.keyDown(field, { key: "Escape", code: "Escape" });

    expect(onReject).not.toHaveBeenCalled();
    expect(screen.queryByPlaceholderText(/describe the changes/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /approve/i })).toBeInTheDocument();
  });

  it("Escape rejects when the feedback field is closed", () => {
    const onReject = vi.fn();
    render(<PlanApprovalBar onApprove={vi.fn()} onRequestChanges={vi.fn()} onReject={onReject} />);
    fireEvent.keyDown(window, { key: "Escape", code: "Escape" });
    expect(onReject).toHaveBeenCalledOnce();
  });

  it("shows allowed prompts when provided", () => {
    render(
      <PlanApprovalBar
        allowedPrompts={[{ tool: "Bash", prompt: "run tests" }]}
        onApprove={vi.fn()}
        onRequestChanges={vi.fn()}
      />,
    );
    expect(screen.getByText("run tests")).toBeInTheDocument();
  });

  it("uses command-y to approve", () => {
    const onApprove = vi.fn();
    render(<PlanApprovalBar onApprove={onApprove} onRequestChanges={vi.fn()} />);

    fireEvent.keyDown(window, { key: "y", code: "KeyY", metaKey: true });

    expect(onApprove).toHaveBeenCalledOnce();
  });

  it("uses command-n to request changes with a reason", () => {
    render(<PlanApprovalBar onApprove={vi.fn()} onRequestChanges={vi.fn()} />);

    fireEvent.keyDown(window, { key: "n", code: "KeyN", metaKey: true });

    expect(screen.getByPlaceholderText(/describe the changes/i)).toBeInTheDocument();
  });

  it("does not use command-number for plan approval", () => {
    const onApprove = vi.fn();
    render(<PlanApprovalBar onApprove={onApprove} onRequestChanges={vi.fn()} />);

    fireEvent.keyDown(window, { key: "1", metaKey: true });

    expect(onApprove).not.toHaveBeenCalled();
  });

  it("disables every decision while one is in flight", () => {
    const onApprove = vi.fn();
    const onReject = vi.fn();
    render(
      <PlanApprovalBar
        onApprove={onApprove}
        onRequestChanges={vi.fn()}
        onReject={onReject}
        isSubmitting
      />,
    );

    const approve = screen.getByRole("button", { name: /approve & execute/i });
    expect(approve).toBeDisabled();
    expect(approve).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("button", { name: /request changes/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /reject & stop/i })).toBeDisabled();

    fireEvent.keyDown(window, { key: "y", code: "KeyY", metaKey: true });
    fireEvent.keyDown(window, { key: "Escape", code: "Escape" });
    expect(onApprove).not.toHaveBeenCalled();
    expect(onReject).not.toHaveBeenCalled();
  });
});
