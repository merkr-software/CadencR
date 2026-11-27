import { useUiTranslation } from "@/lib/i18n/ui";
import { useCallback, useMemo, type ReactElement } from "react";
import { LightboxThumbnail } from "@/components/image-lightbox/LightboxThumbnail";
import { useBlobUrls } from "@/hooks/useBlobUrls";
import { promptImageSrc } from "@/lib/prompt-image-cache";
import { openImageLightbox, type LightboxImage } from "@/stores/image-lightbox-store";
import type { ParsedUserMessageImage } from "@/types/agent-types";

interface UserMessageImagesProps {
  images: ParsedUserMessageImage[];
}

const NO_BLOB_URLS: ReadonlyMap<string, string> = new Map();
const NO_FAILED_HASHES: ReadonlySet<string> = new Set();

/**
 * Image attachments inside a sent user message.
 *
 * A single image gets a generous preview — it is usually a screenshot the whole
 * message is about — while several collapse to a square grid so a bubble with
 * six of them stays scannable.
 *
 * Payloads reach this component three ways: inline base64, a renderer-memory
 * `ref` from `prompt-image-cache`, or a `blobHash` the backend off-loaded to
 * disk. Only the last needs a network fetch, so it is isolated in
 * {@link BlobBackedUserMessageImages} — a message with no off-loaded payload
 * never touches react-query, which keeps this leaf renderable without a
 * QueryClient.
 */
export function UserMessageImages({ images }: UserMessageImagesProps): ReactElement | null {
  const blobHashes = useMemo(
    () => images.flatMap((image) => (image.blobHash ? [image.blobHash] : [])),
    [images],
  );

  if (blobHashes.length > 0) {
    return <BlobBackedUserMessageImages images={images} hashes={blobHashes} />;
  }
  return <ImageGrid images={images} blobUrls={NO_BLOB_URLS} failed={NO_FAILED_HASHES} />;
}

/** Resolves off-loaded payloads to object URLs, then renders the same grid. */
function BlobBackedUserMessageImages({
  images,
  hashes,
}: UserMessageImagesProps & { hashes: string[] }): ReactElement | null {
  const { urls, failed } = useBlobUrls(hashes);
  return <ImageGrid images={images} blobUrls={urls} failed={failed} />;
}

function ImageGrid({
  images,
  blobUrls,
  failed,
}: UserMessageImagesProps & {
  blobUrls: ReadonlyMap<string, string>;
  failed: ReadonlySet<string>;
}): ReactElement | null {
  const { t } = useUiTranslation();
  const resolved = useMemo(
    () =>
      images.map((image, position): LightboxImage => {
        const alt =
          images.length > 1
            ? t(
                "conversation.stream.userMessageImages.attachedImage",
                "attached image {{position}}",
                { position: position + 1 },
              )
            : t("conversation.stream.userMessageImages.attachedImageLabel", "attached image");
        return {
          // Refs and hashes are both content fingerprints, so two copies of one
          // screenshot in a single message share one — the position keeps React
          // keys unique and lets the viewer tell the two slots apart.
          id: `${image.blobHash ?? image.ref ?? "inline"}-${position}`,
          // A hash still loading resolves to null, which renders the same
          // placeholder as an evicted ref rather than a broken image.
          src: image.blobHash ? (blobUrls.get(image.blobHash) ?? null) : promptImageSrc(image),
          alt,
          mediaType: image.mediaType,
        };
      }),
    [images, blobUrls, t],
  );
  const open = useCallback((position: number) => openImageLightbox(resolved, position), [resolved]);

  if (resolved.length === 0) return null;
  const solo = resolved.length === 1;
  const unavailable = images.some((image) => image.blobHash && failed.has(image.blobHash));

  return (
    <div className="mt-2 flex flex-col gap-1.5">
      <div className="flex flex-wrap gap-2">
        {resolved.map((image, position) => (
          <LightboxThumbnail
            key={image.id}
            src={image.src}
            alt={image.alt}
            onOpen={() => open(position)}
            className={solo ? "max-h-64" : "size-24"}
            imageClassName={solo ? "max-h-64 max-w-full object-contain" : "size-full object-cover"}
          />
        ))}
      </div>
      {/* A blob that can't be fetched is gone, not slow. Saying so beats a
          placeholder the user would otherwise wait on indefinitely. */}
      {unavailable ? (
        <p className="text-xs text-muted-foreground">
          {t("conversation.stream.userMessageImages.storageUnavailable", {
            count: images.length,
            defaultValue_one: "This image is no longer available in local storage.",
            defaultValue_other: "Some images are no longer available in local storage.",
          })}
        </p>
      ) : null}
    </div>
  );
}
