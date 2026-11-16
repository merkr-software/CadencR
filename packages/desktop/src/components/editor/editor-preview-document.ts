// This is the first parsed policy in both documents. Later untrusted meta/base
// elements cannot widen CSP; the iframe retains its separate opaque origin.
const PREVIEW_CSP_META = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data: blob:; media-src data: blob:; connect-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'" />`;

const PREVIEW_CLOSE_BRIDGE_SCRIPT = String.raw`
      window.addEventListener("keydown", (event) => {
        if ((event.metaKey !== event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "w") {
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

export function buildHtmlPreviewDocument(content: string): string {
  return `<!doctype html><html><head>${PREVIEW_CSP_META}</head><body>${content}<script>${PREVIEW_CLOSE_BRIDGE_SCRIPT}</script></body></html>`;
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

export function buildSvgPreviewDocument(content: string): string {
  return `<!doctype html>
<html>
  <head>
    ${PREVIEW_CSP_META}
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
