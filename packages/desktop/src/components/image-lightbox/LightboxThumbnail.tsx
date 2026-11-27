import { useUiTranslation } from "@/lib/i18n/ui";
import { ImageOffIcon, MaximizeIcon } from "lucide-react";
import { useEffect, useState, type ReactElement } from "react";
import { cn } from "@/lib/utils";

interface LightboxThumbnailProps {
  /** `null` once the payload was evicted from the blob cache. */
  src: string | null;
  alt: string;
  onOpen: () => void;
  /** Sizing for the button box. */
  className?: string;
  imageClassName?: string;
}

/**
 * A clickable image preview that opens the lightbox, shared by sent messages
 * and the composer's attachment row.
 *
 * Falls back to a chip whenever the payload cannot be shown — either the ref
 * was already evicted (`src === null`) or the URL was revoked out from under a
 * mounted image, which is the one case the blob cache cannot signal any other
 * way. Without the `error` fallback that second case renders as the browser's
 * broken-image glyph.
 */
export function LightboxThumbnail({
  src,
  alt,
  onOpen,
  className,
  imageClassName,
}: LightboxThumbnailProps): ReactElement {
  const { t } = useUiTranslation();
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);

  if (!src || failed) {
    return (
      <span
        className={cn(
          "inline-flex max-w-full items-center gap-1.5 rounded-md border border-border",
          "bg-background/70 px-2 py-1 font-mono text-[11.5px] text-muted-foreground",
        )}
      >
        <ImageOffIcon className="size-3.5 shrink-0" aria-hidden="true" />
        <span className="truncate">
          {t("conversation.stream.lightboxThumbnail.imageUnavailable", "Image unavailable")}
        </span>
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={t("conversation.stream.lightboxThumbnail.open", "Open {{alt}}", { alt })}
      title={alt}
      className={cn(
        "group/thumb relative block overflow-hidden rounded-md border border-border",
        "cursor-zoom-in transition-colors hover:border-primary/60",
        className,
      )}
    >
      <img
        src={src}
        alt={alt}
        draggable={false}
        onError={() => setFailed(true)}
        className={cn("block", imageClassName)}
      />
      {/*
        Hover affordance driven by colour, not opacity: the touch stylesheet
        force-reveals every `hover:opacity-100` element (index.css, "Touch /
        mobile affordances"), which would leave this scrim permanently over the
        thumbnail on a phone.
      */}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 flex items-center justify-center bg-transparent transition-colors group-hover/thumb:bg-black/40"
      >
        <MaximizeIcon className="size-4 text-transparent transition-colors group-hover/thumb:text-white/90" />
      </span>
    </button>
  );
}
