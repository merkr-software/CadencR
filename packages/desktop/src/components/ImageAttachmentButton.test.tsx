import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@/test-utils";
import { ImageAttachmentButton } from "./ImageAttachmentButton";

describe("ImageAttachmentButton", () => {
  it("renders a button with paperclip icon", () => {
    render(<ImageAttachmentButton onFilesSelected={vi.fn()} />);
    expect(screen.getByRole("button", { name: /attach files/i })).toBeInTheDocument();
  });

  it("is disabled when disabled prop is true", () => {
    render(<ImageAttachmentButton onFilesSelected={vi.fn()} disabled />);
    expect(screen.getByRole("button")).toBeDisabled();
  });

  it("calls onFilesSelected when files are chosen", async () => {
    const onFilesSelected = vi.fn();
    const { container } = render(<ImageAttachmentButton onFilesSelected={onFilesSelected} />);

    const input = container.querySelector("input[type='file']") as HTMLInputElement;
    const file = new File(["img"], "test.png", { type: "image/png" });

    // Simulate file selection
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    const event = new Event("change", { bubbles: true });
    input.dispatchEvent(event);

    expect(onFilesSelected).toHaveBeenCalled();
  });

  it("renders hidden file input accepting images and text files", () => {
    const { container } = render(<ImageAttachmentButton onFilesSelected={vi.fn()} />);
    const input = container.querySelector("input[type='file']");
    expect(input).toBeInTheDocument();
    expect(input).toHaveClass("hidden");
    expect(input).toHaveAttribute("accept", expect.stringContaining("image/"));
    expect(input).toHaveAttribute("accept", expect.stringContaining(".csv"));
    expect(input).toHaveAttribute("multiple");
  });
});
