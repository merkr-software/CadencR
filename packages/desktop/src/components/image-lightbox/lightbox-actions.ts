import { translateUi } from "@/lib/i18n/ui";
import { toast } from "sonner";
import { apiErrorMessage } from "@/lib/api-errors";
import { extensionForMime } from "@/lib/prompt-attachments";

/** Extension guessed from the MIME type, for the download filename. */
function extensionFor(mediaType: string | undefined): string {
  return (mediaType && extensionForMime(mediaType)) || "png";
}

export function lightboxFileName(fileName: string | undefined, mediaType: string | undefined) {
  if (fileName) return fileName;
  return `image.${extensionFor(mediaType)}`;
}

/**
 * Re-encode to PNG through a canvas. The async clipboard only accepts a short
 * list of types across browsers — PNG is the one that is always allowed — so a
 * JPEG or WebP has to be converted before it can be written.
 */
async function toPngBlob(blob: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext("2d");
  if (!context)
    throw new Error(
      translateUi(
        "conversation.stream.lightboxActions.canvas2DContextUnavailable",
        "Canvas 2D context unavailable",
      ),
    );
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  const png = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!png)
    throw new Error(
      translateUi(
        "conversation.stream.lightboxActions.couldNotEncodeTheImageAsPng",
        "Could not encode the image as PNG",
      ),
    );
  return png;
}

export async function copyLightboxImage(src: string): Promise<void> {
  try {
    const blob = await (await fetch(src)).blob();
    const png = blob.type === "image/png" ? blob : await toPngBlob(blob);
    await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
    toast.success(
      translateUi(
        "conversation.stream.lightboxActions.imageCopiedToTheClipboard",
        "Image copied to the clipboard",
      ),
    );
  } catch (error) {
    toast.error(
      translateUi(
        "conversation.stream.lightboxActions.couldnTCopyTheImage",
        "Couldn't copy the image",
      ),
      {
        description: apiErrorMessage(
          error,
          translateUi(
            "conversation.stream.lightboxActions.theClipboardRejectedTheImage",
            "The clipboard rejected the image",
          ),
        ),
      },
    );
  }
}

export function downloadLightboxImage(src: string, fileName: string): void {
  try {
    const link = document.createElement("a");
    link.href = src;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
  } catch (error) {
    toast.error(
      translateUi(
        "conversation.stream.lightboxActions.couldnTSaveTheImage",
        "Couldn't save the image",
      ),
      {
        description: apiErrorMessage(
          error,
          translateUi(
            "conversation.stream.lightboxActions.theDownloadCouldNotBeStarted",
            "The download could not be started",
          ),
        ),
      },
    );
  }
}
