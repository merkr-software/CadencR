import { translateUi } from "@/lib/i18n/ui";
import { useState, useEffect, useCallback, useMemo, useRef, type MutableRefObject } from "react";
import { toast } from "sonner";
import { apiErrorMessage } from "@/lib/api-errors";
import { desktopBridge, type FileDropItem } from "@/lib/desktop-bridge";
import {
  getAttachmentKindForProvider,
  IMAGE_MIME_TYPES,
  normalizeAttachmentMime,
  unsupportedAttachmentDescription,
  type PromptAttachmentKind,
} from "@/lib/prompt-attachments";

export interface ImageAttachment {
  id: string;
  fileName: string;
  base64: string;
  mimeType: string;
  kind: PromptAttachmentKind;
  previewUrl: string;
}

export interface ImageAttachmentDragHandlers {
  onDragOver: (event: React.DragEvent) => void;
  onDrop: (event: React.DragEvent) => void;
}

export interface UseImageAttachmentsResult {
  attachments: ImageAttachment[];
  addFiles: (files: FileList | File[]) => void;
  removeAttachment: (id: string) => void;
  clearAttachments: (options?: { revokeObjectUrls?: boolean }) => void;
  restoreAttachments: (next: ImageAttachment[]) => void;
  dragHandlers: ImageAttachmentDragHandlers;
  /**
   * Always `false`. The visual drag highlight is now owned by the agent
   * `<section>` in `WebSocketSessionFeatureBlock` (via `data-agent-dragover`);
   * the hook keeps this field for back-compat with consumer mocks but no
   * longer drives any UI.
   */
  isDragging: boolean;
}

export const ALLOWED_IMAGE_TYPES: string[] = [...IMAGE_MIME_TYPES];
const MAX_FILES = 10;
const MAX_SIZE_BYTES = 20 * 1024 * 1024; // 20MB

function filePreviewUrl(file: File, kind: PromptAttachmentKind): string {
  return kind === "image" ? URL.createObjectURL(file) : "";
}

function droppedFilePreviewUrl(
  base64: string,
  mimeType: string,
  kind: PromptAttachmentKind,
): string {
  return kind === "image" ? `data:${mimeType};base64,${base64}` : "";
}

function useAttachmentAdders(
  providerId: string | undefined,
  attachmentsRef: MutableRefObject<ImageAttachment[]>,
  addAttachment: (attachment: ImageAttachment) => void,
) {
  const addFiles = useCallback(
    (files: FileList | File[]) => {
      const remaining = MAX_FILES - attachmentsRef.current.length;
      if (remaining <= 0) return;
      Array.from(files)
        .slice(0, remaining)
        .forEach((file) => {
          const mimeType = normalizeAttachmentMime(file.name, file.type);
          const kind = getAttachmentKindForProvider(providerId, file.name, mimeType);
          if (!kind) {
            toast.error(
              translateUi(
                "conversation.composer.useImageAttachments.unsupportedFile",
                "Unsupported file: {{file}}",
                { file: file.name },
              ),
              {
                description: unsupportedAttachmentDescription(providerId),
              },
            );
            return;
          }
          if (file.size > MAX_SIZE_BYTES) return;
          const reader = new FileReader();
          reader.addEventListener("load", (event) => {
            const dataUrl = event.target?.result as string;
            addAttachment({
              id: crypto.randomUUID(),
              fileName: file.name,
              base64: dataUrl.split(",")[1],
              mimeType,
              kind,
              previewUrl: filePreviewUrl(file, kind),
            });
          });
          reader.readAsDataURL(file);
        });
    },
    [addAttachment, attachmentsRef, providerId],
  );
  const addDroppedFiles = useCallback(
    async (files: FileDropItem[]) => {
      const remaining = MAX_FILES - attachmentsRef.current.length;
      if (remaining <= 0) return;
      for (const file of files.slice(0, remaining)) {
        const mimeType = normalizeAttachmentMime(file.name, "");
        const kind = getAttachmentKindForProvider(providerId, file.name, mimeType);
        if (!kind) {
          toast.error(
            translateUi(
              "conversation.composer.useImageAttachments.unsupportedFile",
              "Unsupported file: {{file}}",
              { file: file.name },
            ),
            {
              description: unsupportedAttachmentDescription(providerId),
            },
          );
          continue;
        }
        try {
          const base64 = await desktopBridge.readFileBase64(file.handle);
          addAttachment({
            id: crypto.randomUUID(),
            fileName: file.name,
            base64,
            mimeType,
            kind,
            previewUrl: droppedFilePreviewUrl(base64, mimeType, kind),
          });
        } catch (error) {
          const message = apiErrorMessage(error, String(error));
          toast.error(
            translateUi(
              "conversation.composer.useImageAttachments.attachFailed",
              "Couldn't attach {{file}}",
              { file: file.name },
            ),
            { description: message },
          );
        }
      }
    },
    [addAttachment, attachmentsRef, providerId],
  );
  return useMemo(() => ({ addFiles, addDroppedFiles }), [addDroppedFiles, addFiles]);
}

function useFileDropSubscription(
  promptId: string | undefined,
  addDroppedFiles: (files: FileDropItem[]) => Promise<void>,
): void {
  const addDroppedFilesRef = useRef(addDroppedFiles);
  addDroppedFilesRef.current = addDroppedFiles;
  useEffect(
    () =>
      desktopBridge.onFileDrop((event) => {
        if (event.type === "drop") {
          if (event.files.length === 0) return;
          if (!event.targetPromptId) {
            toast.error(
              translateUi(
                "conversation.composer.useImageAttachments.missingTarget",
                "Drop the image on an agent to attach it.",
              ),
              {
                id: "image-drop-missing-target",
              },
            );
            return;
          }
          if (promptId && event.targetPromptId !== promptId) return;
          void addDroppedFilesRef.current(event.files);
        } else if (event.type === "error") {
          toast.error(
            translateUi(
              "conversation.composer.useImageAttachments.readDropFailed",
              "Couldn't read dropped files.",
            ),
            {
              id: "image-drop-read-error",
              description:
                event.message ??
                translateUi(
                  "conversation.composer.useImageAttachments.dropRejected",
                  "The desktop shell rejected the dropped file paths.",
                ),
            },
          );
        }
      }),
    [promptId],
  );
}

export function useImageAttachments(
  promptId?: string,
  providerId?: string,
): UseImageAttachmentsResult {
  const [attachments, setAttachments] = useState<ImageAttachment[]>([]);
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
  // `isDragging` used to be driven from the preload's document-level
  // `enter`/`leave` events, which fired for every mounted prompt bar at once
  // — so a drag anywhere in the window lit up every card in the unified grid.
  // The drag highlight now lives on the agent `<section>` (via React drag
  // handlers + a `data-agent-dragover` attribute) so only the card under the
  // cursor highlights. We keep this field for back-compat with existing
  // mocks; new consumers should read drag state from the section.
  const isDragging = false;

  const addAttachment = useCallback((attachment: ImageAttachment) => {
    setAttachments((prev) => {
      if (prev.length >= MAX_FILES) return prev;
      return [...prev, attachment];
    });
  }, []);

  const { addFiles, addDroppedFiles } = useAttachmentAdders(
    providerId,
    attachmentsRef,
    addAttachment,
  );
  useFileDropSubscription(promptId, addDroppedFiles);

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => {
      const target = prev.find((a) => a.id === id);
      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((a) => a.id !== id);
    });
  }, []);

  const clearAttachments = useCallback((options?: { revokeObjectUrls?: boolean }) => {
    setAttachments((prev) => {
      if (options?.revokeObjectUrls !== false) {
        prev.forEach((a) => {
          if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
        });
      }
      return [];
    });
  }, []);

  const restoreAttachments = useCallback((next: ImageAttachment[]) => {
    setAttachments(next);
  }, []);

  // React-level handlers — kept for back-compat. The Electron preload now
  // calls `preventDefault()` on dragover at the document level, and the
  // section owns the visual feedback; these are no-ops left in the API so
  // callers spreading `dragHandlers` onto the prompt-bar wrapper keep
  // working.
  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
  }, []);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
  }, []);

  const dragHandlers = useMemo(() => ({ onDragOver, onDrop }), [onDragOver, onDrop]);

  return useMemo(
    () => ({
      attachments,
      addFiles,
      removeAttachment,
      clearAttachments,
      restoreAttachments,
      dragHandlers,
      isDragging,
    }),
    [
      attachments,
      addFiles,
      removeAttachment,
      clearAttachments,
      restoreAttachments,
      dragHandlers,
      isDragging,
    ],
  );
}
