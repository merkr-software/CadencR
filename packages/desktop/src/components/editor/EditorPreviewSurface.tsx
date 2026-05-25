/**
 * Dispatch surface for the in-editor "Preview" toggle. Given the
 * current buffer content + the file's `PreviewKind`, renders the
 * matching preview (Markdown, HTML iframe, or sandboxed HTML/SVG iframe).
 *
 * Lazy-loaded by `CodeMirrorEditor` so the Markdown bundle only
 * downloads when a preview is actually opened. HTML and SVG previews
 * are tiny iframe renderers, so they don't need their own lazy chunks.
 */
import { memo, useEffect, useMemo, useRef } from "react";
import type { PreviewKind } from "@/lib/file-language";
import { Markdown } from "@/components/Markdown";
import { CheckerboardBackdrop } from "./CheckerboardBackdrop";

interface EditorPreviewSurfaceProps {
  kind: PreviewKind;
  content: string;
  /** Stable key used by the Markdown renderer's cache. */
  filePath: string;
}

export const EditorPreviewSurface = memo(function EditorPreviewSurface({
  kind,
  content,
  filePath,
}: EditorPreviewSurfaceProps) {
  const previewFrameRef = useRef<HTMLIFrameElement | null>(null);
  const htmlDocument = useMemo(() => buildHtmlPreviewDocument(content), [content]);
  const svgDocument = useMemo(() => buildSvgPreviewDocument(content), [content]);

  useEffect(() => {
    function handleMessage(event: MessageEvent<PreviewShortcutMessage>): void {
      if (event.source !== previewFrameRef.current?.contentWindow) return;
      if (!isPreviewShortcutMessage(event.data)) return;
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: event.data.key,
          code: event.data.code,
          metaKey: event.data.metaKey,
          ctrlKey: event.data.ctrlKey,
          shiftKey: event.data.shiftKey,
          altKey: event.data.altKey,
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
        <div className="flex-1 overflow-auto bg-background">
          <div className="max-w-3xl mx-auto px-6 py-4">
            <Markdown content={content} cacheKey={filePath} />
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
              className="h-full w-full border-0 bg-transparent"
            />
          </CheckerboardBackdrop>
        </div>
      );
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
});

interface PreviewShortcutMessage {
  type: "cadencr-preview-shortcut";
  shortcut: "editor-close";
  key: string;
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

function isPreviewShortcutMessage(value: unknown): value is PreviewShortcutMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Record<string, unknown>;
  return message.type === "cadencr-preview-shortcut" && message.shortcut === "editor-close";
}

const PREVIEW_CLOSE_BRIDGE_SCRIPT = String.raw`
      window.addEventListener("keydown", (event) => {
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "w") {
          event.preventDefault();
          window.parent.postMessage({
            type: "cadencr-preview-shortcut",
            shortcut: "editor-close",
            key: event.key,
            code: event.code || "KeyW",
            metaKey: event.metaKey,
            ctrlKey: event.ctrlKey,
            shiftKey: event.shiftKey,
            altKey: event.altKey,
          }, "*");
        }
      });
`;

function buildHtmlPreviewDocument(content: string): string {
  const bridge = `<script>${PREVIEW_CLOSE_BRIDGE_SCRIPT}</script>`;
  if (/<\/body\s*>/i.test(content)) {
    return content.replace(/<\/body\s*>/i, `${bridge}</body>`);
  }
  return `${content}${bridge}`;
}

const SVG_PREVIEW_STYLES = String.raw`
      html,
      body {
        margin: 0;
        width: 100%;
        height: 100%;
        overflow: hidden;
        background: transparent;
      }

      #preview-stage {
        position: fixed;
        inset: 0;
        overflow: hidden;
      }

      #preview-root {
        position: absolute;
        left: 0;
        top: 0;
        transform-origin: 0 0;
        will-change: transform;
      }

      svg {
        display: block;
        max-width: none;
        max-height: none;
      }
`;

const SVG_PREVIEW_SCRIPT = `
      (() => {
        const MIN_SCALE = 0.05;
        const MAX_SCALE = 16;
        const PINCH_SENSITIVITY = 0.01;
        const stage = document.getElementById("preview-stage");
        const root = document.getElementById("preview-root");
        if (!stage || !root) return;

        let view = null;
        let contentWidth = 0;
        let contentHeight = 0;

        function clamp(value, min, max) {
          return Math.min(max, Math.max(min, value));
        }

        function measureContent() {
          root.style.transform = "translate(0px, 0px) scale(1)";
          const rect = root.getBoundingClientRect();
          contentWidth = Math.max(1, rect.width);
          contentHeight = Math.max(1, rect.height);
        }

        function computeFitView() {
          const rect = stage.getBoundingClientRect();
          const scale = Math.min(rect.width / contentWidth, rect.height / contentHeight, 1);
          return {
            scale,
            tx: (rect.width - contentWidth * scale) / 2,
            ty: (rect.height - contentHeight * scale) / 2,
          };
        }

        function clampView(next) {
          const rect = stage.getBoundingClientRect();
          const renderedWidth = contentWidth * next.scale;
          const renderedHeight = contentHeight * next.scale;
          const tx = renderedWidth <= rect.width
            ? (rect.width - renderedWidth) / 2
            : Math.min(0, Math.max(rect.width - renderedWidth, next.tx));
          const ty = renderedHeight <= rect.height
            ? (rect.height - renderedHeight) / 2
            : Math.min(0, Math.max(rect.height - renderedHeight, next.ty));
          return { scale: next.scale, tx, ty };
        }

        function applyView(next) {
          view = clampView(next);
          root.style.transformOrigin = "0 0";
          root.style.transform = "translate(" + view.tx + "px, " + view.ty + "px) scale(" + view.scale + ")";
        }

        function resetToFit() {
          measureContent();
          applyView(computeFitView());
        }

        stage.addEventListener("wheel", (event) => {
          const isPinch = event.ctrlKey || event.metaKey;
          if (!isPinch && event.deltaX === 0 && event.deltaY === 0) return;
          event.preventDefault();

          const base = view || computeFitView();
          let next;
          if (isPinch) {
            const rect = stage.getBoundingClientRect();
            const cx = event.clientX - rect.left;
            const cy = event.clientY - rect.top;
            const newScale = clamp(
              base.scale * Math.exp(-event.deltaY * PINCH_SENSITIVITY),
              MIN_SCALE,
              MAX_SCALE,
            );
            const ratio = newScale / base.scale;
            next = {
              scale: newScale,
              tx: cx - (cx - base.tx) * ratio,
              ty: cy - (cy - base.ty) * ratio,
            };
          } else {
            next = { scale: base.scale, tx: base.tx - event.deltaX, ty: base.ty - event.deltaY };
          }
          applyView(next);
        }, { passive: false });

        stage.addEventListener("dblclick", resetToFit);
        window.addEventListener("resize", resetToFit);
        ${PREVIEW_CLOSE_BRIDGE_SCRIPT}

        resetToFit();
      })();
`;

function buildSvgPreviewDocument(content: string): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>${SVG_PREVIEW_STYLES}</style>
  </head>
  <body>
    <div id="preview-stage">
      <div id="preview-root">${content}</div>
    </div>
    <script>${SVG_PREVIEW_SCRIPT}</script>
  </body>
</html>`;
}
