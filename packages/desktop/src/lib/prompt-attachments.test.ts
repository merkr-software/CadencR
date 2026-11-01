import { describe, expect, it } from "vitest";
import {
  attachmentAcceptForProvider,
  getAttachmentKindForProvider,
  unsupportedAttachmentDescription,
} from "./prompt-attachments";
import { setProviderCatalogMetadata } from "./provider-catalog-registry";

describe("prompt attachment provider support", () => {
  it("allows Claude Code images, PDFs, and text-like files", () => {
    expect(getAttachmentKindForProvider("claude_code", "diagram.png", "image/png")).toBe("image");
    expect(getAttachmentKindForProvider("claude_code", "brief.pdf", "application/pdf")).toBe(
      "document",
    );
    expect(getAttachmentKindForProvider("claude_code", "data.csv", "text/csv")).toBe("text");
  });

  it("allows OpenCode ACP image, audio, and embedded resources", () => {
    expect(getAttachmentKindForProvider("opencode", "diagram.webp", "image/webp")).toBe("image");
    expect(getAttachmentKindForProvider("opencode", "clip.wav", "audio/wav")).toBe("audio");
    expect(getAttachmentKindForProvider("opencode", "brief.pdf", "application/pdf")).toBe(
      "resource",
    );
  });

  it("allows Codex images, PDFs, and Excel workbooks through app-server file references", () => {
    expect(getAttachmentKindForProvider("codex_cli", "diagram.jpg", "image/jpeg")).toBe("image");
    expect(getAttachmentKindForProvider("codex_cli", "brief.pdf", "application/pdf")).toBe(
      "document",
    );
    expect(
      getAttachmentKindForProvider(
        "codex_cli",
        "budget.xlsx",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ),
    ).toBe("document");
    expect(
      getAttachmentKindForProvider("codex_cli", "legacy.xls", "application/vnd.ms-excel"),
    ).toBe("document");
    expect(getAttachmentKindForProvider("codex_cli", "data.csv", "text/csv")).toBeNull();
  });

  it("gives installed providers images and inlined text, no PDFs, while capabilities are unknown", () => {
    expect(getAttachmentKindForProvider("cursor", "diagram.png", "image/png")).toBe("image");
    expect(getAttachmentKindForProvider("pi", "notes.txt", "text/plain")).toBe("text");
    expect(getAttachmentKindForProvider("pi", "data.csv", "text/csv")).toBe("text");
    expect(getAttachmentKindForProvider("cursor", "brief.pdf", "application/pdf")).toBeNull();
    expect(attachmentAcceptForProvider("cursor")).toContain("image/png");
    expect(attachmentAcceptForProvider("cursor")).toContain("text/plain");
    expect(attachmentAcceptForProvider("cursor")).not.toContain("application/pdf");
    expect(unsupportedAttachmentDescription("cursor")).toContain("images and text-like files");
  });

  it("follows an installed provider's prompt capabilities", () => {
    const rich = { image: true, audio: false, embedded_context: true };
    expect(getAttachmentKindForProvider("acme", "brief.pdf", "application/pdf", rich)).toBe(
      "document",
    );
    expect(getAttachmentKindForProvider("acme", "clip.wav", "audio/wav", rich)).toBeNull();
    expect(attachmentAcceptForProvider("acme", rich)).toContain("application/pdf");
    expect(unsupportedAttachmentDescription("acme", rich)).toContain("images, PDFs and text-like");

    const textOnly = { image: false, audio: false, embedded_context: false };
    expect(getAttachmentKindForProvider("acme", "shot.png", "image/png", textOnly)).toBeNull();
    expect(
      getAttachmentKindForProvider("acme", "brief.pdf", "application/pdf", textOnly),
    ).toBeNull();
    expect(getAttachmentKindForProvider("acme", "notes.md", "text/markdown", textOnly)).toBe(
      "text",
    );
    expect(attachmentAcceptForProvider("acme", textOnly)).not.toContain("image/png");
    expect(unsupportedAttachmentDescription("acme", textOnly)).toBe(
      "This provider accepts text-like files such as TXT, CSV, Markdown, and JSON.",
    );
  });

  it("reads prompt capabilities from the published catalog", () => {
    setProviderCatalogMetadata([
      {
        id: "acme",
        label: "Acme",
        prompt_capabilities: {
          image: true,
          audio: false,
          embedded_context: true,
        },
      },
    ]);
    expect(getAttachmentKindForProvider("acme", "brief.pdf", "application/pdf")).toBe("document");
    setProviderCatalogMetadata([]);
  });

  it("builds provider-specific file picker accept lists and descriptions", () => {
    expect(attachmentAcceptForProvider("codex_cli")).toBe(
      "image/png,image/jpeg,image/gif,image/webp,application/pdf,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    expect(attachmentAcceptForProvider("claude_code")).toContain("application/pdf");
    expect(attachmentAcceptForProvider("opencode")).toContain("audio/wav");
    expect(unsupportedAttachmentDescription("codex_cli")).toContain(
      "Codex accepts images, PDFs, and Excel spreadsheets",
    );
  });
});
