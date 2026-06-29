import { memo } from "react";
import { ZoomInIcon, ZoomOutIcon, Maximize2Icon } from "lucide-react";
import { usePanZoom } from "@/hooks/usePanZoom";
import { cn } from "@/lib/utils";

interface MermaidDiagramViewProps {
  svg: string;
}

const CONTROL_CLASS =
  "flex size-6 items-center justify-center rounded text-foreground/70 hover:bg-accent hover:text-foreground transition-colors";

/**
 * Renders a mermaid SVG inside a scrollable zoom viewport: native two-finger
 * scroll pans both axes, pinch zooms around the pointer, Cmd/Ctrl + drag pans,
 * and on-hover controls zoom in/out and reset-to-fit. The SVG is injected with
 * `dangerouslySetInnerHTML` by the caller, which runs mermaid at
 * `securityLevel: "strict"`, so the markup is safe.
 */
export const MermaidDiagramView = memo(function MermaidDiagramView({
  svg,
}: MermaidDiagramViewProps) {
  const {
    containerRef,
    contentRef,
    contentStyle,
    isPanning,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    zoomIn,
    zoomOut,
    reset,
  } = usePanZoom(svg);

  return (
    <div className="relative p-3">
      <div className="absolute right-2 top-2 z-10 flex items-center gap-0.5 rounded-md border border-border bg-background/80 p-0.5 opacity-0 backdrop-blur-sm transition-opacity group-hover/codeblock:opacity-100">
        <button type="button" onClick={zoomOut} className={CONTROL_CLASS} title="Zoom out">
          <ZoomOutIcon className="size-3.5" />
        </button>
        <button type="button" onClick={reset} className={CONTROL_CLASS} title="Reset zoom">
          <Maximize2Icon className="size-3.5" />
        </button>
        <button type="button" onClick={zoomIn} className={CONTROL_CLASS} title="Zoom in">
          <ZoomInIcon className="size-3.5" />
        </button>
      </div>
      <div
        ref={containerRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        className={cn(
          "max-h-[32rem] overflow-auto overscroll-contain",
          isPanning ? "cursor-grabbing select-none" : "cursor-default",
        )}
        title="Scroll to pan · pinch to zoom · ⌘-drag to pan"
      >
        <div
          ref={contentRef}
          className="[&_svg]:block [&_svg]:h-full [&_svg]:w-full [&_svg]:max-w-none"
          style={contentStyle}
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      </div>
    </div>
  );
});
