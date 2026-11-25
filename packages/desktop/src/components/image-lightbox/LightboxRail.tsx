import { useUiTranslation } from "@/lib/i18n/ui";
import { ImageOffIcon } from "lucide-react";
import { memo, type ReactElement } from "react";
import { cn } from "@/lib/utils";
import type { LightboxImage } from "@/stores/image-lightbox-store";

interface LightboxRailProps {
  images: LightboxImage[];
  index: number;
  onSelect: (index: number) => void;
}

/** Thumbnail rail, shown only when a message carried more than one image. */
function LightboxRailImpl({ images, index, onSelect }: LightboxRailProps): ReactElement | null {
  if (images.length < 2) return null;
  const { t } = useUiTranslation();
  return (
    <div className="flex shrink-0 justify-center px-6 pb-6">
      <div className="flex max-w-full gap-2 overflow-x-auto rounded-lg border border-white/10 bg-black/45 p-2 backdrop-blur-md">
        {images.map((image, position) => (
          <button
            key={image.id}
            type="button"
            onClick={() => onSelect(position)}
            aria-label={t("conversation.stream.lightboxRail.show", "Show {{image}}", {
              image: image.alt,
            })}
            aria-current={position === index ? "true" : undefined}
            className={cn(
              "size-12 shrink-0 overflow-hidden rounded-md border transition-all",
              position === index
                ? "border-primary opacity-100"
                : "border-white/15 opacity-55 hover:opacity-90",
            )}
          >
            {image.src ? (
              <img src={image.src} alt="" className="size-full object-cover" draggable={false} />
            ) : (
              <span className="flex size-full items-center justify-center bg-white/5">
                <ImageOffIcon className="size-4 text-white/50" aria-hidden="true" />
              </span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}

// Re-rendered by every pointer-rate zoom/pan update otherwise, re-creating each
// thumbnail button and its click closure.
export const LightboxRail = memo(LightboxRailImpl);
