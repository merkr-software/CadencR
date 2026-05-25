import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@/test-utils";
import { EditorPreviewSurface } from "./EditorPreviewSurface";

vi.mock("@/components/Markdown", () => ({
  Markdown: ({ content }: { content: string }) => (
    <div data-testid="markdown-preview">{content}</div>
  ),
}));

function getSrcDoc(): string {
  const iframe = screen.getByTitle("SVG preview");
  expect(iframe).toBeInstanceOf(HTMLIFrameElement);
  return iframe.getAttribute("srcdoc") ?? "";
}

describe("EditorPreviewSurface", () => {
  it("renders SVG content inside a sandboxed iframe", () => {
    const content = '<svg onload="window.parent.evil = true"><circle cx="4" cy="4" r="4" /></svg>';

    const { container } = render(
      <EditorPreviewSurface kind="svg" content={content} filePath="preview.svg" />,
    );

    const iframe = screen.getByTitle("SVG preview");

    expect(iframe).toBeInstanceOf(HTMLIFrameElement);
    expect(iframe).toHaveAttribute("sandbox", "allow-scripts");
    expect(iframe).toHaveAttribute("srcdoc", expect.stringContaining(content));
    expect(container.querySelector("svg")).toBeNull();
  });

  it("bridges mod-w from the sandboxed HTML preview to the editor close shortcut", () => {
    render(<EditorPreviewSurface kind="html" content="<h1>Preview</h1>" filePath="preview.html" />);

    const iframe = screen.getByTitle("HTML preview");
    const srcDoc = iframe.getAttribute("srcdoc") ?? "";

    expect(srcDoc).toContain("cadencr-preview-shortcut");
    expect(srcDoc).toContain("editor-close");
    expect(srcDoc).toContain("keydown");
  });

  it("bridges mod-w from the sandboxed SVG preview to the editor close shortcut", () => {
    render(<EditorPreviewSurface kind="svg" content="<svg />" filePath="preview.svg" />);

    const srcDoc = getSrcDoc();

    expect(srcDoc).toContain("cadencr-preview-shortcut");
    expect(srcDoc).toContain("editor-close");
    expect(srcDoc).toContain("keydown");
  });

  it("adds cursor-anchored wheel zoom support to the sandboxed SVG preview", () => {
    render(<EditorPreviewSurface kind="svg" content="<svg />" filePath="preview.svg" />);

    const srcDoc = getSrcDoc();

    expect(srcDoc).toContain('addEventListener("wheel"');
    expect(srcDoc).toContain("Math.exp(-event.deltaY");
    expect(srcDoc).toContain('transformOrigin = "0 0"');
  });
});
