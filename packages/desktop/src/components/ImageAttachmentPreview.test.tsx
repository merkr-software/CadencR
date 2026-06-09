import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@/test-utils";
import { ImageAttachmentPreview } from "./ImageAttachmentPreview";
import type { ImageAttachment, TextAttachment } from "@/hooks/useImageAttachments";

function makeAttachment(overrides: Partial<ImageAttachment> = {}): ImageAttachment {
  return {
    id: "att-1",
    fileName: "image.png",
    previewUrl: "data:image/png;base64,abc123",
    base64: "abc123",
    mimeType: "image/png",
    ...overrides,
  };
}

function makeTextAttachment(overrides: Partial<TextAttachment> = {}): TextAttachment {
  return {
    id: "txt-1",
    fileName: "data.csv",
    text: "a,b\n1,2",
    sizeBytes: 7,
    ...overrides,
  };
}

describe("ImageAttachmentPreview", () => {
  it("renders nothing when attachments is empty", () => {
    const { container } = render(<ImageAttachmentPreview attachments={[]} onRemove={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders image previews", () => {
    const attachments = [
      makeAttachment({ id: "1", fileName: "photo.png" }),
      makeAttachment({ id: "2", fileName: "shot.jpg" }),
    ];
    render(<ImageAttachmentPreview attachments={attachments} onRemove={vi.fn()} />);
    expect(screen.getAllByRole("img")).toHaveLength(2);
  });

  it("renders a file chip (not an image) for text attachments", () => {
    render(<ImageAttachmentPreview attachments={[makeTextAttachment()]} onRemove={vi.fn()} />);
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByText("data.csv")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /remove data\.csv/i })).toBeInTheDocument();
  });

  it("renders remove button for each attachment", () => {
    const att = makeAttachment({ id: "x", fileName: "pic.png" });
    render(<ImageAttachmentPreview attachments={[att]} onRemove={vi.fn()} />);
    expect(screen.getByRole("button", { name: /remove pic\.png/i })).toBeInTheDocument();
  });

  it("calls onRemove with the attachment id when remove clicked", async () => {
    const onRemove = vi.fn();
    const att = makeAttachment({ id: "test-id", fileName: "img.png" });
    const { user } = render(<ImageAttachmentPreview attachments={[att]} onRemove={onRemove} />);
    await user.click(screen.getByRole("button", { name: /remove/i }));
    expect(onRemove).toHaveBeenCalledWith("test-id");
  });

  it("applies custom className", () => {
    const att = makeAttachment();
    const { container } = render(
      <ImageAttachmentPreview attachments={[att]} onRemove={vi.fn()} className="extra-class" />,
    );
    expect(container.firstChild).toHaveClass("extra-class");
  });
});
