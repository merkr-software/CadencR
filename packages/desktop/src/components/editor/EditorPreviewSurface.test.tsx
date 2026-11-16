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
  it("enables rich copy for Markdown previews", () => {
    const { container } = render(
      <EditorPreviewSurface
        kind="markdown"
        content="# Preview"
        filePath="preview.md"
        projectId={1}
        featureId={1}
      />,
    );

    expect(screen.getByTestId("markdown-preview")).toHaveTextContent("# Preview");
    expect(container.querySelector("[data-rich-copy='true']")).toBeInTheDocument();
  });

  it("renders SVG content inside a sandboxed iframe", () => {
    const content = '<svg onload="window.parent.evil = true"><circle cx="4" cy="4" r="4" /></svg>';

    const { container } = render(
      <EditorPreviewSurface
        kind="svg"
        content={content}
        filePath="preview.svg"
        projectId={1}
        featureId={1}
      />,
    );

    const iframe = screen.getByTitle("SVG preview");

    expect(iframe).toBeInstanceOf(HTMLIFrameElement);
    expect(iframe).toHaveAttribute("sandbox", "allow-scripts");
    expect(iframe).toHaveAttribute("srcdoc", expect.stringContaining(content));
    expect(container.querySelector("svg")).toBeNull();
  });

  it("bridges mod-w from the sandboxed HTML preview to the editor close shortcut", () => {
    render(
      <EditorPreviewSurface
        kind="html"
        content="<h1>Preview</h1>"
        filePath="preview.html"
        projectId={1}
        featureId={1}
      />,
    );

    const iframe = screen.getByTitle("HTML preview");
    const srcDoc = iframe.getAttribute("srcdoc") ?? "";

    expect(srcDoc).toContain("cadencr-preview-shortcut");
    expect(srcDoc).toContain("editor-close");
    expect(srcDoc).toContain("keydown");
  });

  it("bridges mod-w from the sandboxed SVG preview to the editor close shortcut", () => {
    render(
      <EditorPreviewSurface
        kind="svg"
        content="<svg />"
        filePath="preview.svg"
        projectId={1}
        featureId={1}
      />,
    );

    const srcDoc = getSrcDoc();

    expect(srcDoc).toContain("cadencr-preview-shortcut");
    expect(srcDoc).toContain("editor-close");
    expect(srcDoc).toContain("keydown");
  });

  it("adds cursor-anchored wheel zoom support to the sandboxed SVG preview", () => {
    render(
      <EditorPreviewSurface
        kind="svg"
        content="<svg />"
        filePath="preview.svg"
        projectId={1}
        featureId={1}
      />,
    );

    const srcDoc = getSrcDoc();

    expect(srcDoc).toContain('addEventListener("wheel"');
    expect(srcDoc).toContain("Math.exp(-event.deltaY");
    expect(srcDoc).toContain('transformOrigin = "0 0"');
  });
});

it("does not dispatch arbitrary host shortcuts from a forged preview message", () => {
  render(
    <EditorPreviewSurface
      kind="html"
      content="<h1>Preview</h1>"
      filePath="preview.html"
      projectId={1}
      featureId={1}
    />,
  );
  const frame = screen.getByTitle<HTMLIFrameElement>("HTML preview");
  const onKey = vi.fn();
  window.addEventListener("keydown", onKey);
  const message = {
    type: "cadencr-preview-shortcut",
    shortcut: "editor-close",
    key: "k",
    code: "KeyK",
    metaKey: true,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
  };
  window.dispatchEvent(new MessageEvent("message", { source: frame.contentWindow, data: message }));
  expect(onKey).not.toHaveBeenCalled();
  window.dispatchEvent(
    new MessageEvent("message", {
      source: frame.contentWindow,
      data: { ...message, key: "w", code: "KeyZ" },
    }),
  );
  expect(onKey).toHaveBeenCalledOnce();
  expect(onKey.mock.calls[0][0]).toMatchObject({
    key: "w",
    code: "KeyW",
    metaKey: true,
    shiftKey: false,
    altKey: false,
  });
  window.removeEventListener("keydown", onKey);
});
