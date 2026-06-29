import { memo, useEffect, useState } from "react";
import { CodeIcon, EyeIcon, Loader2Icon, AlertTriangleIcon } from "lucide-react";
import { CodeBlockShell } from "@/components/CodeBlockShell";
import { MermaidDiagramView } from "@/components/MermaidDiagramView";
import { cachedHighlight } from "@/components/Markdown";
import { useTheme } from "@/hooks/useTheme";

/** Load mermaid once across every diagram so it stays out of the main chunk. */
let mermaidPromise: Promise<typeof import("mermaid")> | null = null;
const loadMermaid = (): Promise<typeof import("mermaid")> => (mermaidPromise ??= import("mermaid"));

/** LRU cache of rendered SVG, keyed on appearance + source. */
const svgCache = new Map<string, string>();
const SVG_CACHE_MAX = 100;
function cacheSvg(key: string, svg: string): void {
  if (svgCache.size >= SVG_CACHE_MAX) {
    const oldest = svgCache.keys().next().value;
    if (oldest !== undefined) svgCache.delete(oldest);
  }
  svgCache.set(key, svg);
}

let idCounter = 0;

type RenderState =
  | { status: "loading" }
  | { status: "ready"; svg: string }
  | { status: "error"; message: string };

interface MermaidDiagramProps {
  code: string;
}

const MermaidDiagram = memo(function MermaidDiagram({ code }: MermaidDiagramProps) {
  const appearance = useTheme().theme.appearance;
  const [view, setView] = useState<"diagram" | "source">("diagram");
  const [state, setState] = useState<RenderState>({ status: "loading" });

  useEffect(() => {
    if (view !== "diagram") return;
    const key = `${appearance}\0${code}`;
    const cached = svgCache.get(key);
    if (cached !== undefined) {
      setState({ status: "ready", svg: cached });
      return;
    }
    let cancelled = false;
    setState({ status: "loading" });
    void (async () => {
      try {
        const { default: mermaid } = await loadMermaid();
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          // Never let mermaid inject its error "bomb" diagram into document.body;
          // on a failed render it leaks a stray, un-React-managed node there.
          suppressErrorRendering: true,
          theme: appearance === "dark" ? "dark" : "default",
        });
        // Validate first: parse() throws on invalid syntax without touching the
        // DOM, so we never reach render() (and its DOM-leaking error path) for
        // invalid output. Invalid diagrams fall back to the source view below.
        await mermaid.parse(code);
        const { svg } = await mermaid.render(`mermaid-${idCounter++}`, code);
        if (cancelled) return;
        cacheSvg(key, svg);
        setState({ status: "ready", svg });
      } catch (err) {
        if (cancelled) return;
        setState({
          status: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [code, appearance, view]);

  const isError = state.status === "error";
  const showSource = view === "source" || isError;

  return (
    <CodeBlockShell
      language="mermaid"
      code={code}
      leadingActions={
        <button
          type="button"
          onClick={() => setView((v) => (v === "diagram" ? "source" : "diagram"))}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-foreground/70 hover:bg-accent hover:text-foreground transition-colors"
          title={view === "diagram" ? "View source" : "View diagram"}
        >
          {view === "diagram" ? (
            <>
              <CodeIcon className="size-3" />
              <span>Source</span>
            </>
          ) : (
            <>
              <EyeIcon className="size-3" />
              <span>Diagram</span>
            </>
          )}
        </button>
      }
    >
      {isError && (
        <div className="flex items-center gap-1.5 border-b border-border bg-destructive/10 px-3 py-1 text-xs text-destructive">
          <AlertTriangleIcon className="size-3 shrink-0" />
          <span>Could not render diagram: {state.message}</span>
        </div>
      )}
      {showSource ? (
        <pre className="overflow-x-auto p-3 text-xs leading-relaxed">
          <code className="hljs">{cachedHighlight("text", code) ?? code}</code>
        </pre>
      ) : state.status === "loading" ? (
        <div className="flex items-center gap-2 p-3 text-xs text-muted-foreground">
          <Loader2Icon className="size-3 animate-spin" />
          <span>Rendering diagram…</span>
        </div>
      ) : (
        <MermaidDiagramView svg={state.svg} />
      )}
    </CodeBlockShell>
  );
});

export default MermaidDiagram;
