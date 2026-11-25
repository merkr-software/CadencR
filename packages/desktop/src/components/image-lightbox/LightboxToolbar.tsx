import { useUiTranslation } from "@/lib/i18n/ui";
import { memo, type ReactElement, type ReactNode } from "react";
import {
  CopyIcon,
  DownloadIcon,
  Maximize2Icon,
  XIcon,
  ZoomInIcon,
  ZoomOutIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { MAX_ZOOM, MIN_ZOOM } from "./useLightboxZoom";

interface LightboxToolbarProps {
  scale: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onReset: () => void;
  onCopy: () => void;
  onDownload: () => void;
  onClose: () => void;
  /** Disabled while the payload is unresolvable (evicted from the cache). */
  actionsDisabled: boolean;
}

/** Controls sit on a dark glass bar, so they override `ghost`'s themed colours. */
const CONTROL_CLASS = "text-white/75 hover:bg-white/10 hover:text-white";

function LightboxToolbarImpl({
  scale,
  onZoomIn,
  onZoomOut,
  onReset,
  onCopy,
  onDownload,
  onClose,
  actionsDisabled,
}: LightboxToolbarProps): ReactElement {
  const { t } = useUiTranslation();
  return (
    <div className="flex items-center gap-1 rounded-lg border border-white/10 bg-black/45 p-1 backdrop-blur-md">
      <ToolbarButton
        onClick={onZoomOut}
        disabled={scale <= MIN_ZOOM}
        label={t("conversation.stream.lightboxToolbar.zoomOut", "Zoom out (−)")}
      >
        <ZoomOutIcon />
      </ToolbarButton>
      <Button
        variant="ghost"
        size="sm"
        onClick={onReset}
        title={t("conversation.stream.lightboxToolbar.resetZoom0", "Reset zoom (0)")}
        className={`min-w-14 font-mono text-xs ${CONTROL_CLASS}`}
      >
        {Math.round(scale * 100)}%
      </Button>
      <ToolbarButton
        onClick={onZoomIn}
        disabled={scale >= MAX_ZOOM}
        label={t("conversation.stream.lightboxToolbar.zoomIn", "Zoom in (+)")}
      >
        <ZoomInIcon />
      </ToolbarButton>
      <ToolbarButton
        onClick={onReset}
        disabled={scale === MIN_ZOOM}
        label={t("conversation.stream.lightboxToolbar.fitToScreen0", "Fit to screen (0)")}
      >
        <Maximize2Icon />
      </ToolbarButton>
      <ToolbarSeparator />
      <ToolbarButton
        onClick={onCopy}
        disabled={actionsDisabled}
        label={t("conversation.stream.lightboxToolbar.copyImage", "Copy image")}
      >
        <CopyIcon />
      </ToolbarButton>
      <ToolbarButton
        onClick={onDownload}
        disabled={actionsDisabled}
        label={t("conversation.stream.lightboxToolbar.saveImage", "Save image")}
      >
        <DownloadIcon />
      </ToolbarButton>
      <ToolbarSeparator />
      <ToolbarButton
        onClick={onClose}
        label={t("conversation.stream.lightboxToolbar.closeEsc", "Close (Esc)")}
      >
        <XIcon />
      </ToolbarButton>
    </div>
  );
}

function ToolbarSeparator(): ReactElement {
  return <Separator orientation="vertical" className="mx-0.5 h-5 bg-white/15" />;
}

function ToolbarButton({
  onClick,
  label,
  disabled = false,
  children,
}: {
  onClick: () => void;
  label: string;
  disabled?: boolean;
  children: ReactNode;
}): ReactElement {
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className={CONTROL_CLASS}
    >
      {children}
    </Button>
  );
}

// Pointer-rate zoom/pan updates re-render the lightbox shell; the toolbar's
// props only change on a discrete zoom step.
export const LightboxToolbar = memo(LightboxToolbarImpl);
