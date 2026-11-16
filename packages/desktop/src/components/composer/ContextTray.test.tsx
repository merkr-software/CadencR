import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@/test-utils";
import type { ImageAttachment } from "@/hooks/useImageAttachments";
import { AttachmentChips } from "./ContextTray";

function attachment(overrides: Partial<ImageAttachment> = {}): ImageAttachment {
  return {
    id: "att-1",
    fileName: "image.png",
    previewUrl: "data:image/png;base64,abc123",
    base64: "abc123",
    mimeType: "image/png",
    kind: "image",
    ...overrides,
  };
}

describe("AttachmentChips", () => {
  it("shows images as thumbnails and other files by name", () => {
    render(
      <AttachmentChips
        items={[
          attachment({ id: "1", fileName: "photo.png" }),
          attachment({
            id: "2",
            fileName: "brief.pdf",
            kind: "document",
            mimeType: "application/pdf",
          }),
        ]}
        onRemove={vi.fn()}
      />,
    );
    expect(screen.getAllByRole("img")).toHaveLength(1);
    expect(screen.getByText("brief.pdf")).toBeInTheDocument();
  });

  it("removes an attachment by id", async () => {
    const onRemove = vi.fn();
    const { user } = render(
      <AttachmentChips
        items={[attachment({ id: "x", fileName: "pic.png" })]}
        onRemove={onRemove}
      />,
    );
    await user.click(screen.getByRole("button", { name: /remove pic\.png/i }));
    expect(onRemove).toHaveBeenCalledWith("x");
  });
});
