/**
 * Dispatch surface for the in-editor "Preview" toggle. Given the
 * current buffer content + the file's `PreviewKind`, renders the
 * matching preview (Markdown, HTML iframe, sandboxed HTML/SVG iframe, or the
 * CSV / TSV table).
 *
 * Lazy-loaded by `CodeMirrorEditor` so the Markdown bundle only
 * downloads when a preview is actually opened. HTML and SVG previews
 * are tiny iframe renderers, so they don't need their own lazy chunks.
 */
import { memo, useEffect, useMemo, useRef } from "react";
import { CsvTable } from "@/components/document-preview/csv/CsvTable";
import { getFileName, type PreviewKind } from "@/lib/file-language";
import { Markdown } from "@/components/Markdown";
import { MarkdownImageProvider } from "@/components/markdown-image";
import { CheckerboardBackdrop } from "./CheckerboardBackdrop";
import { PreviewImageProvider, PreviewMarkdownImage } from "./PreviewMarkdownImage";
import { buildHtmlPreviewDocument, buildSvgPreviewDocument } from "./editor-preview-document";
import { previewCloseKey } from "./preview-shortcut";

interface EditorPreviewSurfaceProps {
  kind: PreviewKind;
  content: string;
  /** Path of the previewed file, relative to the project root. Doubles as the
   * Markdown renderer's cache key and the base for resolving local images. */
  filePath: string;
  projectId: number;
  featureId: number;
}

export const EditorPreviewSurface = memo(function EditorPreviewSurface({
  kind,
  content,
  filePath,
  projectId,
  featureId,
}: EditorPreviewSurfaceProps) {
  const previewFrameRef = useRef<HTMLIFrameElement | null>(null);
  const htmlDocument = useMemo(() => buildHtmlPreviewDocument(content), [content]);
  const svgDocument = useMemo(() => buildSvgPreviewDocument(content), [content]);
  const imageContext = useMemo(() => {
    const slash = filePath.lastIndexOf("/");
    return { projectId, featureId, baseDir: slash === -1 ? "" : filePath.slice(0, slash) };
  }, [filePath, projectId, featureId]);

  useEffect(() => {
    function handleMessage(event: MessageEvent<unknown>): void {
      if (event.source !== previewFrameRef.current?.contentWindow) return;
      const closeKey = previewCloseKey(event.data);
      if (!closeKey) return;
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          ...closeKey,
          bubbles: true,
          cancelable: true,
        }),
      );
    }

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, []);

  switch (kind) {
    case "markdown":
      return (
        <div className="flex-1 overflow-auto bg-background" data-rich-copy="true">
          <div className="max-w-3xl mx-auto px-6 py-4">
            <PreviewImageProvider value={imageContext}>
              <MarkdownImageProvider value={PreviewMarkdownImage}>
                <Markdown content={content} cacheKey={filePath} />
              </MarkdownImageProvider>
            </PreviewImageProvider>
          </div>
        </div>
      );
    case "html":
      return (
        <div className="flex-1 overflow-hidden bg-background">
          {/* `allow-scripts` lets inline JS run, still isolates from same-origin. */}
          <iframe
            ref={previewFrameRef}
            title="HTML preview"
            srcDoc={htmlDocument}
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
            className="w-full h-full border-0 bg-background"
          />
        </div>
      );
    case "svg":
      return (
        <div className="flex-1 overflow-hidden">
          <CheckerboardBackdrop>
            {/* Match HTML preview isolation while keeping the checkerboard visible behind transparent SVGs. */}
            <iframe
              ref={previewFrameRef}
              title="SVG preview"
              srcDoc={svgDocument}
              sandbox="allow-scripts"
              referrerPolicy="no-referrer"
              className="h-full w-full border-0 bg-transparent"
            />
          </CheckerboardBackdrop>
        </div>
      );
    case "csv":
      return (
        <div className="flex min-h-0 flex-1 flex-col">
          <CsvTable source={content} fileName={getFileName(filePath)} />
        </div>
      );
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
});
