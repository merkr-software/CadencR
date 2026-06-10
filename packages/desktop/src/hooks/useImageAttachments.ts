import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { toast } from "sonner";
import { desktopBridge, type FileDropItem } from "@/lib/desktop-bridge";
import {
  ATTACHMENT_SUPPORT_HINT,
  MAX_ATTACHMENT_FILES,
  MAX_IMAGE_BYTES,
  MAX_PDF_BYTES,
  MAX_TEXT_BYTES,
  base64ToBytes,
  classifyAttachment,
  decodeBase64Utf8,
  isImageAttachment,
  type PromptAttachment,
} from "@/lib/prompt-attachments";
import { extractPdfText } from "@/lib/pdf-text";

// Re-exported so existing importers (`@/hooks/useImageAttachments`) keep
// working; the canonical home for attachment types/guards is
// `@/lib/prompt-attachments`.
export type { ImageAttachment, TextAttachment, PromptAttachment } from "@/lib/prompt-attachments";
export { isImageAttachment, isTextAttachment } from "@/lib/prompt-attachments";

export interface ImageAttachmentDragHandlers {
  onDragOver: (event: React.DragEvent) => void;
  onDrop: (event: React.DragEvent) => void;
}

export interface UseImageAttachmentsResult {
  attachments: PromptAttachment[];
  addFiles: (files: FileList | File[]) => void;
  removeAttachment: (id: string) => void;
  clearAttachments: (options?: { revokeObjectUrls?: boolean }) => void;
  restoreAttachments: (next: PromptAttachment[]) => void;
  dragHandlers: ImageAttachmentDragHandlers;
  /**
   * Always `false`. The visual drag highlight is now owned by the agent
   * `<section>` in `WebSocketSessionFeatureBlock` (via `data-agent-dragover`);
   * the hook keeps this field for back-compat with consumer mocks but no
   * longer drives any UI.
   */
  isDragging: boolean;
}

export function useImageAttachments(promptId?: string): UseImageAttachmentsResult {
  const [attachments, setAttachments] = useState<PromptAttachment[]>([]);
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

  const addAttachment = useCallback((attachment: PromptAttachment) => {
    setAttachments((prev) => {
      if (prev.length >= MAX_ATTACHMENT_FILES) return prev;
      return [...prev, attachment];
    });
  }, []);

  // Parse a PDF's text in-app, then attach it like any other text file.
  // Extraction is async and can be slow, so a loading toast covers the
  // wait; the attachment chip appearing is the success signal.
  const attachPdf = useCallback(
    async (fileName: string, readBytes: () => Promise<ArrayBuffer | Uint8Array>): Promise<void> => {
      const toastId = `pdf-extract-${fileName}`;
      toast.loading(`Reading ${fileName}…`, { id: toastId });
      try {
        const text = (await extractPdfText(await readBytes())).trim();
        if (!text) {
          toast.error(`Couldn't extract text from ${fileName}`, {
            id: toastId,
            description: "It may be a scanned or image-only PDF.",
          });
          return;
        }
        toast.dismiss(toastId);
        addAttachment({ id: crypto.randomUUID(), fileName, text, sizeBytes: text.length });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        toast.error(`Couldn't read ${fileName}`, { id: toastId, description: message });
      }
    },
    [addAttachment],
  );

  const addFiles = useCallback(
    (files: FileList | File[]) => {
      const fileArray = Array.from(files);
      const remaining = MAX_ATTACHMENT_FILES - attachmentsRef.current.length;
      if (remaining <= 0) return;

      fileArray.slice(0, remaining).forEach((file) => {
        const classification = classifyAttachment(file.name, file.type);
        if (classification.kind === "unsupported") return;

        if (classification.kind === "image") {
          if (file.size > MAX_IMAGE_BYTES) return;
          const reader = new FileReader();
          reader.addEventListener("load", (e) => {
            const dataUrl = e.target?.result as string;
            const base64 = dataUrl.split(",")[1];
            const previewUrl = URL.createObjectURL(file);
            addAttachment({
              id: crypto.randomUUID(),
              fileName: file.name,
              base64,
              mimeType: classification.mimeType,
              previewUrl,
            });
          });
          reader.readAsDataURL(file);
          return;
        }

        if (classification.kind === "pdf") {
          if (file.size > MAX_PDF_BYTES) {
            toast.error(`${file.name} is too large to attach`, {
              description: "PDF attachments must be under 20 MB.",
            });
            return;
          }
          void attachPdf(file.name, () => file.arrayBuffer());
          return;
        }

        // Text file: inline its contents into the prompt at send time.
        if (file.size > MAX_TEXT_BYTES) {
          toast.error(`${file.name} is too large to attach`, {
            description: "Text attachments must be under 1 MB.",
          });
          return;
        }
        const reader = new FileReader();
        reader.addEventListener("load", (e) => {
          const text = (e.target?.result as string) ?? "";
          addAttachment({
            id: crypto.randomUUID(),
            fileName: file.name,
            text,
            sizeBytes: file.size,
          });
        });
        reader.readAsText(file, "utf-8");
      });
    },
    [addAttachment, attachPdf],
  );

  const addDroppedFiles = useCallback(
    async (files: FileDropItem[]) => {
      const remaining = MAX_ATTACHMENT_FILES - attachmentsRef.current.length;
      if (remaining <= 0) return;

      for (const file of files.slice(0, remaining)) {
        const classification = classifyAttachment(file.name);
        if (classification.kind === "unsupported") {
          toast.error(`Unsupported file: ${file.name}`, {
            description: ATTACHMENT_SUPPORT_HINT,
          });
          continue;
        }

        try {
          const base64 = await desktopBridge.readFileBase64(file.handle);
          if (classification.kind === "image") {
            const previewUrl = `data:${classification.mimeType};base64,${base64}`;
            addAttachment({
              id: crypto.randomUUID(),
              fileName: file.name,
              base64,
              mimeType: classification.mimeType,
              previewUrl,
            });
          } else if (classification.kind === "pdf") {
            const bytes = base64ToBytes(base64);
            if (bytes.byteLength > MAX_PDF_BYTES) {
              toast.error(`${file.name} is too large to attach`, {
                description: "PDF attachments must be under 20 MB.",
              });
              continue;
            }
            await attachPdf(file.name, async () => bytes);
          } else {
            // Enforce the same limit as browser-picked text files. Estimate
            // the decoded size from the base64 length so a huge dropped file
            // is rejected before it's decoded into a string.
            const sizeBytes = Math.floor((base64.length * 3) / 4);
            if (sizeBytes > MAX_TEXT_BYTES) {
              toast.error(`${file.name} is too large to attach`, {
                description: "Text attachments must be under 1 MB.",
              });
              continue;
            }
            addAttachment({
              id: crypto.randomUUID(),
              fileName: file.name,
              text: decodeBase64Utf8(base64),
              sizeBytes,
            });
          }
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          toast.error(`Couldn't attach ${file.name}`, { description: message });
        }
      }
    },
    [addAttachment, attachPdf],
  );

  // Stable ref so the effect doesn't re-register on every render
  const addDroppedFilesRef = useRef(addDroppedFiles);
  addDroppedFilesRef.current = addDroppedFiles;

  // Listen for OS-level file drops (e.g. from Finder). The agent `<section>`
  // owns the visual drop-zone state; this effect only routes the file payload
  // to the prompt under the cursor.
  useEffect(() => {
    return desktopBridge.onFileDrop((event) => {
      if (event.type === "drop") {
        // Non-file drags (text, links) still produce a drop event with no
        // files — bail so we don't surface any user-facing noise for inert
        // drops.
        if (event.files.length === 0) return;
        // No matching prompt under the cursor (e.g. the drop landed on the
        // sidebar or empty grid space). Surface one toast — sonner's `id`
        // collapses concurrent calls from every mounted subscriber into a
        // single visible toast.
        if (!event.targetPromptId) {
          const many = event.files.length > 1;
          toast.error(
            many
              ? "Drop the files on an agent to attach them."
              : "Drop the file on an agent to attach it.",
            { id: "attachment-drop-missing-target" },
          );
          return;
        }
        if (promptId && event.targetPromptId !== promptId) return;
        void addDroppedFilesRef.current(event.files);
      } else if (event.type === "error") {
        toast.error("Couldn't read dropped files.", {
          id: "image-drop-read-error",
          description: event.message ?? "The desktop shell rejected the dropped file paths.",
        });
      }
      // `enter` / `leave` are intentionally ignored — the per-section React
      // drag handlers in `WebSocketSessionFeatureBlock` own the highlight.
    });
  }, [promptId]); // eslint-disable-line react-hooks/exhaustive-deps

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => {
      const target = prev.find((a) => a.id === id);
      if (target && isImageAttachment(target)) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((a) => a.id !== id);
    });
  }, []);

  const clearAttachments = useCallback((options?: { revokeObjectUrls?: boolean }) => {
    setAttachments((prev) => {
      if (options?.revokeObjectUrls !== false) {
        prev.forEach((a) => {
          if (isImageAttachment(a)) URL.revokeObjectURL(a.previewUrl);
        });
      }
      return [];
    });
  }, []);

  const restoreAttachments = useCallback((next: PromptAttachment[]) => {
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
