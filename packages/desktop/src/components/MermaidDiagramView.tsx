import { memo, useMemo, type KeyboardEvent, type ReactNode } from "react";
import { Maximize2Icon, RotateCcwIcon, XIcon, ZoomInIcon, ZoomOutIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { usePanZoom, type PanZoom } from "@/hooks/usePanZoom";
import { formatKey } from "@/lib/shortcuts/format";
import { cn } from "@/lib/utils";
import { sanitizeDiagramSvg } from "@/lib/sanitize-diagram-svg";

type ControlSize = "icon-xs" | "icon-sm";

const PAN_MODIFIER = formatKey("mod");

/** Full-screen keys, modal-local like the image lightbox's: not app-wide shortcuts. */
const KEY_ACTIONS: Partial<Record<string, "zoomIn" | "zoomOut" | "reset">> = {
  "+": "zoomIn",
  "=": "zoomIn",
  "-": "zoomOut",
  "0": "reset",
};

function ControlButton({
  size,
  label,
  onClick,
  children,
}: {
  size: ControlSize;
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Button variant="ghost" size={size} onClick={onClick} title={label} aria-label={label}>
      {children}
    </Button>
  );
}

function ZoomControls({
  size,
  zoomIn,
  zoomOut,
  reset,
}: Pick<PanZoom, "zoomIn" | "zoomOut" | "reset"> & { size: ControlSize }) {
  return (
    <>
      <ControlButton size={size} label="Zoom out (−)" onClick={zoomOut}>
        <ZoomOutIcon />
      </ControlButton>
      <ControlButton size={size} label="Reset zoom (0)" onClick={reset}>
        <RotateCcwIcon />
      </ControlButton>
      <ControlButton size={size} label="Zoom in (+)" onClick={zoomIn}>
        <ZoomInIcon />
      </ControlButton>
    </>
  );
}

/**
 * `inline` sits in a message: fit to width, hover controls, and a full-screen
 * button when `onExpand` is given. `fullscreen` fills its parent, fits the
 * whole diagram, and keeps its controls and exit button in a header bar.
 */
type MermaidDiagramViewProps = { svg: string } & (
  | { variant?: "inline"; onExpand?: () => void }
  | { variant: "fullscreen"; onClose: () => void }
);

/**
 * Renders a mermaid SVG inside a scrollable zoom viewport: native two-finger
 * scroll pans both axes, pinch zooms around the pointer, Cmd/Ctrl + drag pans,
 * and the controls zoom in/out and reset to fit. Both renderers' final SVG
 * passes through the same local sanitizer before entering the app document.
 */
export const MermaidDiagramView = memo(function MermaidDiagramView(props: MermaidDiagramViewProps) {
  const fullscreen = props.variant === "fullscreen";
  const svg = useMemo(() => sanitizeDiagramSvg(props.svg), [props.svg]);
  const panZoom = usePanZoom(svg, fullscreen ? "contain" : "width");
  const { zoomIn, zoomOut, reset } = panZoom;
  const zoom = { zoomIn, zoomOut, reset };

  const onKeyDown = (event: KeyboardEvent) => {
    const action = KEY_ACTIONS[event.key];
    if (!action) return;
    event.preventDefault();
    zoom[action]();
  };

  return (
    <div
      className={cn("relative", fullscreen ? "flex min-h-0 flex-1 flex-col" : "p-3")}
      onKeyDown={fullscreen ? onKeyDown : undefined}
    >
      {props.variant === "fullscreen" ? (
        <div className="flex h-12 shrink-0 items-center justify-end gap-1 border-b border-border px-3">
          <span className="mr-2 text-xs text-muted-foreground">Esc to close</span>
          <ZoomControls size="icon-sm" {...zoom} />
          <Separator orientation="vertical" className="mx-1 data-[orientation=vertical]:h-4" />
          <ControlButton size="icon-sm" label="Exit full screen (Esc)" onClick={props.onClose}>
            <XIcon />
          </ControlButton>
        </div>
      ) : (
        <div className="absolute right-2 top-2 z-10 flex items-center gap-0.5 rounded-md border border-border bg-background/80 p-0.5 opacity-0 backdrop-blur-sm transition-opacity group-hover/codeblock:opacity-100 focus-within:opacity-100">
          <ZoomControls size="icon-xs" {...zoom} />
          {props.onExpand && (
            <ControlButton size="icon-xs" label="Full screen" onClick={props.onExpand}>
              <Maximize2Icon />
            </ControlButton>
          )}
        </div>
      )}
      <div
        ref={panZoom.containerRef}
        onPointerDown={panZoom.onPointerDown}
        onPointerMove={panZoom.onPointerMove}
        onPointerUp={panZoom.onPointerUp}
        className={cn(
          "flex overflow-auto overscroll-contain",
          fullscreen ? "min-h-0 flex-1" : "max-h-[32rem]",
          panZoom.isPanning ? "cursor-grabbing select-none" : "cursor-default",
        )}
        title={`Scroll to pan · pinch to zoom · ${PAN_MODIFIER}-drag to pan`}
      >
        <div
          ref={panZoom.contentRef}
          className="[&_svg]:block [&_svg]:h-full [&_svg]:w-full [&_svg]:max-w-none"
          style={panZoom.contentStyle}
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      </div>
    </div>
  );
});
