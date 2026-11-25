import { useUiTranslation } from "@/lib/i18n/ui";
import { ImageOffIcon } from "lucide-react";
import { useEffect, useState, type ReactElement, type RefObject } from "react";
import { cn } from "@/lib/utils";
import type { LightboxImage } from "@/stores/image-lightbox-store";
import type { LightboxZoom } from "./useLightboxZoom";

interface LightboxCanvasProps {
  image: LightboxImage;
  zoom: LightboxZoom;
  /** The wheel-gesture target and the box the pan is clamped against. */
  surfaceRef: RefObject<HTMLDivElement | null>;
  onLoad: (event: React.SyntheticEvent<HTMLImageElement>) => void;
  /** Clicking the surface around the image dismisses, like any overlay. */
  onDismiss: () => void;
}

export function LightboxCanvas({
  image,
  zoom,
  surfaceRef,
  onLoad,
  onDismiss,
}: LightboxCanvasProps): ReactElement {
  // A cached payload can be evicted (and its URL revoked) while still on
  // screen; the load error is the only signal that reaches us.
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [image.src]);

  return (
    <div
      ref={surfaceRef}
      className="flex min-h-0 flex-1 items-center justify-center overflow-hidden px-6 pb-6"
      onClick={(event) => {
        if (event.target === event.currentTarget) onDismiss();
      }}
    >
      {image.src && !failed ? (
        <img
          src={image.src}
          alt={image.alt}
          onLoad={onLoad}
          onError={() => setFailed(true)}
          onClick={zoom.onClick}
          onPointerDown={zoom.onPointerDown}
          onPointerMove={zoom.onPointerMove}
          onPointerUp={zoom.onPointerUp}
          onPointerCancel={zoom.onPointerUp}
          draggable={false}
          style={{
            transform: `translate3d(${zoom.offset.x}px, ${zoom.offset.y}px, 0) scale(${zoom.scale})`,
            // Snap while the gesture is live so the image tracks the input
            // exactly; ease only the discrete zoom steps.
            transition: zoom.panning ? "none" : "transform 160ms var(--ease-fluid, ease-out)",
          }}
          className={cn(
            "max-h-full max-w-full rounded-sm object-contain shadow-2xl select-none",
            zoom.panning ? "cursor-grabbing" : zoom.zoomed ? "cursor-grab" : "cursor-zoom-in",
          )}
        />
      ) : (
        <UnavailableImage />
      )}
    </div>
  );
}

function UnavailableImage(): ReactElement {
  const { t } = useUiTranslation();
  return (
    <div className="flex flex-col items-center justify-center gap-3 text-white/60">
      <ImageOffIcon className="size-8" aria-hidden="true" />
      <p className="max-w-sm text-center text-sm">
        {t(
          "conversation.stream.lightboxCanvas.thisImageIsNoLongerHeldIn",
          "This image is no longer held in memory. Reload the conversation to fetch it again.",
        )}
      </p>
    </div>
  );
}
