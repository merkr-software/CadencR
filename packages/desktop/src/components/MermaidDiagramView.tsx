import { useUiTranslation } from "@/lib/i18n/ui";
import { memo, useMemo, type KeyboardEvent, type ReactNode } from "react";
import { Maximize2Icon, RotateCcwIcon, XIcon, ZoomInIcon, ZoomOutIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { KBD_HINT_PROPS } from "@/components/KbdShortcut";
import { PhoneViewerHeader } from "@/components/PhoneViewerHeader";
import { RichPreviewFade } from "@/components/markdown/RichPreview";
import { useIsMobile } from "@/hooks/useIsMobile";
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
  const { t } = useUiTranslation();
  return (
    <>
      <ControlButton
        size={size}
        label={t("conversation.stream.mermaidDiagramView.zoomOut", "Zoom out (−)")}
        onClick={zoomOut}
      >
        <ZoomOutIcon />
      </ControlButton>
      <ControlButton
        size={size}
        label={t("conversation.stream.mermaidDiagramView.resetZoom0", "Reset zoom (0)")}
        onClick={reset}
      >
        <RotateCcwIcon />
      </ControlButton>
      <ControlButton
        size={size}
        label={t("conversation.stream.mermaidDiagramView.zoomIn", "Zoom in (+)")}
        onClick={zoomIn}
      >
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

/** The full-screen header: the phone layout's titled 44px bar, or the desktop's controls. */
function FullscreenBar({
  phone,
  zoom,
  onClose,
}: {
  phone: boolean;
  zoom: Pick<PanZoom, "zoomIn" | "zoomOut" | "reset">;
  onClose: () => void;
}) {
  const { t } = useUiTranslation();
  const closeLabel = t(
    "conversation.stream.mermaidDiagramView.exitFullScreenEsc",
    "Exit full screen (Esc)",
  );
  const hint = (
    <span {...KBD_HINT_PROPS} className="mr-2 text-xs text-muted-foreground">
      {t("conversation.stream.mermaidDiagramView.escToClose", "Esc to close")}
    </span>
  );
  if (phone) {
    return (
      <PhoneViewerHeader
        title={t("conversation.stream.mermaidFullscreen.diagram", "Diagram")}
        closeLabel={closeLabel}
        onClose={onClose}
      >
        {hint}
        <ZoomControls size="icon-sm" {...zoom} />
      </PhoneViewerHeader>
    );
  }
  return (
    <div className="flex h-12 shrink-0 items-center justify-end gap-1 border-b border-border px-3">
      {hint}
      <ZoomControls size="icon-sm" {...zoom} />
      <Separator orientation="vertical" className="mx-1 data-[orientation=vertical]:h-4" />
      <ControlButton size="icon-sm" label={closeLabel} onClick={onClose}>
        <XIcon />
      </ControlButton>
    </div>
  );
}

/** A diagram is never shrunk below this in the phone preview; taller ones fade out. */
const PREVIEW_MAX_HEIGHT = 240;

/**
 * The phone layout's inline diagram: fitted to the column, clipped at 240px
 * with a fade, never scrolling (so a swipe over it scrolls the transcript);
 * Expand (or a tap anywhere on it) opens it full screen.
 */
function MermaidPhonePreview({
  svg,
  panZoom,
  onExpand,
}: {
  svg: string;
  panZoom: PanZoom;
  onExpand?: () => void;
}) {
  const { t } = useUiTranslation();
  const height = panZoom.contentStyle.height;
  const clipped = typeof height === "number" && height > PREVIEW_MAX_HEIGHT;
  return (
    <div
      className={cn("relative p-3", onExpand && "cursor-zoom-in")}
      data-diagram-preview
      onClick={onExpand}
    >
      <div ref={panZoom.containerRef} className="flex max-h-60 overflow-hidden">
        <div
          ref={panZoom.contentRef}
          className="[&_svg]:block [&_svg]:h-full [&_svg]:w-full [&_svg]:max-w-none"
          style={panZoom.contentStyle}
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      </div>
      {clipped && <RichPreviewFade />}
      {onExpand && (
        <button
          type="button"
          aria-label={t("conversation.stream.mermaidDiagramView.expandDiagram", "Expand diagram")}
          onClick={(event) => {
            event.stopPropagation();
            onExpand();
          }}
          className="absolute right-3 bottom-3 flex h-11 items-center gap-1.5 rounded-full border border-border bg-background/90 px-4 text-xs text-foreground/80 shadow-xs"
        >
          <Maximize2Icon className="size-3.5" aria-hidden />
          {t("markdown.richPreview.expand", "Expand")}
        </button>
      )}
    </div>
  );
}

/**
 * Renders a mermaid SVG inside a scrollable zoom viewport: native two-finger
 * scroll pans both axes, pinch zooms around the pointer, Cmd/Ctrl + drag pans,
 * and the controls zoom in/out and reset to fit. Both renderers' final SVG
 * passes through the same local sanitizer before entering the app document.
 * On the phone layout the inline diagram is a clipped preview
 * (`MermaidPhonePreview`), and full screen pans with a finger and zooms with
 * a pinch.
 */
export const MermaidDiagramView = memo(function MermaidDiagramView(props: MermaidDiagramViewProps) {
  const { t } = useUiTranslation();
  const phone = useIsMobile();
  const fullscreen = props.variant === "fullscreen";
  const svg = useMemo(() => sanitizeDiagramSvg(props.svg), [props.svg]);
  const fit = fullscreen ? "contain" : phone ? "preview" : "width";
  const panZoom = usePanZoom(svg, fit, { pinch: fullscreen });
  const { zoomIn, zoomOut, reset } = panZoom;
  const zoom = { zoomIn, zoomOut, reset };

  const onKeyDown = (event: KeyboardEvent) => {
    const action = KEY_ACTIONS[event.key];
    if (!action) return;
    event.preventDefault();
    zoom[action]();
  };

  if (props.variant !== "fullscreen" && phone) {
    return <MermaidPhonePreview svg={svg} panZoom={panZoom} onExpand={props.onExpand} />;
  }
  return (
    <div
      className={cn("relative", fullscreen ? "flex min-h-0 flex-1 flex-col" : "p-3")}
      onKeyDown={fullscreen ? onKeyDown : undefined}
    >
      {props.variant === "fullscreen" ? (
        <FullscreenBar phone={phone} zoom={zoom} onClose={props.onClose} />
      ) : (
        <div className="absolute right-2 top-2 z-10 flex items-center gap-0.5 rounded-md border border-border bg-background/80 p-0.5 opacity-0 backdrop-blur-sm transition-opacity group-hover/codeblock:opacity-100 has-[:focus-visible]:opacity-100">
          <ZoomControls size="icon-xs" {...zoom} />
          {props.onExpand && (
            <ControlButton
              size="icon-xs"
              label={t("conversation.stream.mermaidDiagramView.fullScreen", "Full screen")}
              onClick={props.onExpand}
            >
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
          fullscreen ? "min-h-0 flex-1 touch-pan-x touch-pan-y" : "max-h-[32rem]",
          panZoom.isPanning ? "cursor-grabbing select-none" : "cursor-default",
        )}
        title={t(
          "conversation.stream.mermaidDiagramView.scrollToPanPinchToZoom",
          "Scroll to pan · pinch to zoom · {{PAN_MODIFIER}}-drag to pan",
          { PAN_MODIFIER },
        )}
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
