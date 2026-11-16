import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { Loader2Icon, AlertTriangleIcon } from "lucide-react";
import { CodeBlockShell } from "@/components/CodeBlockShell";
import { MermaidDiagramView } from "@/components/MermaidDiagramView";
import { SourceToggle } from "@/components/visuals/SourceToggle";
import { VisualSource } from "@/components/visuals/VisualChrome";
import { useTheme } from "@/hooks/useTheme";
import { apiErrorMessage } from "@/lib/api-errors";
import {
  cachedMermaidSvg,
  namespaceSvgIds,
  renderBeautifulMermaid,
  renderWithMermaid,
} from "@/lib/mermaid-render";
import { openMermaidFullscreen } from "@/stores/mermaid-fullscreen-store";

/** Per-instance id prefix, so no two copies of a diagram share ids. */
let instanceCounter = 0;

/** A beautiful-mermaid SVG, inline and (on demand) full screen under separate ids. */
function BeautifulDiagram({ svg }: { svg: string }) {
  const [prefix] = useState(() => `bm${instanceCounter++}-`);
  const inline = useMemo(() => namespaceSvgIds(svg, prefix), [svg, prefix]);
  const expand = useCallback(
    () => openMermaidFullscreen(namespaceSvgIds(svg, `${prefix}fs-`)),
    [svg, prefix],
  );
  return <MermaidDiagramView svg={inline} onExpand={expand} />;
}

type FallbackState =
  | { status: "loading" }
  | { status: "ready"; svg: string }
  | { status: "error"; message: string };

/**
 * Mermaid's own renderer, for the kinds beautiful-mermaid does not draw.
 * Its SVG is not namespaced: mermaid's `<style>` selects its root by id.
 */
function MermaidFallbackDiagram({ code }: { code: string }) {
  const appearance = useTheme().theme.appearance;
  const cached = cachedMermaidSvg(code, appearance);
  const [state, setState] = useState<FallbackState>({ status: "loading" });
  useEffect(() => {
    if (cachedMermaidSvg(code, appearance) !== undefined) return;
    let cancelled = false;
    setState({ status: "loading" });
    renderWithMermaid(code, appearance).then(
      (svg) => {
        if (!cancelled) setState({ status: "ready", svg });
      },
      (err: unknown) => {
        if (!cancelled) setState({ status: "error", message: apiErrorMessage(err, String(err)) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [code, appearance]);

  // A cached render shows immediately: no loader flash on remount or theme switch.
  const current: FallbackState = cached === undefined ? state : { status: "ready", svg: cached };
  const readySvg = current.status === "ready" ? current.svg : null;
  const expand = useCallback(() => {
    if (readySvg !== null) openMermaidFullscreen(readySvg);
  }, [readySvg]);
  if (current.status === "ready") return <MermaidDiagramView svg={current.svg} onExpand={expand} />;
  if (current.status === "loading") {
    return (
      <div className="flex items-center gap-2 p-3 text-xs text-muted-foreground">
        <Loader2Icon className="size-3 animate-spin" />
        <span>Rendering diagram…</span>
      </div>
    );
  }
  return (
    <>
      <div className="flex items-center gap-1.5 border-b border-border bg-destructive/10 px-3 py-1 text-xs text-destructive">
        <AlertTriangleIcon className="size-3 shrink-0" />
        <span>Could not render diagram: {current.message}</span>
      </div>
      <VisualSource code={code} language="text" />
    </>
  );
}

interface MermaidDiagramProps {
  code: string;
}

const MermaidDiagram = memo(function MermaidDiagram({ code }: MermaidDiagramProps) {
  const [view, setView] = useState<"diagram" | "source">("diagram");
  const beautifulSvg = useMemo(() => renderBeautifulMermaid(code), [code]);

  return (
    <CodeBlockShell
      language="mermaid"
      code={code}
      leadingActions={
        <SourceToggle
          showingSource={view === "source"}
          renderedLabel="Diagram"
          onToggle={() => setView((v) => (v === "diagram" ? "source" : "diagram"))}
        />
      }
    >
      {view === "source" ? (
        <VisualSource code={code} language="text" />
      ) : beautifulSvg !== null ? (
        <BeautifulDiagram svg={beautifulSvg} />
      ) : (
        <MermaidFallbackDiagram code={code} />
      )}
    </CodeBlockShell>
  );
});

export default MermaidDiagram;
