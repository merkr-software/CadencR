import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { toast } from "sonner";
import { desktopBridge, type FileDropItem } from "@/lib/desktop-bridge";

export interface ImageAttachment {
  id: string;
  fileName: string;
  base64: string;
  mimeType: string;
  previewUrl: string;
}

const ALLOWED_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
const EXTENSION_TO_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};
const MAX_FILES = 10;
const MAX_SIZE_BYTES = 20 * 1024 * 1024; // 20MB

function getMimeFromExtension(fileName: string): string | undefined {
  const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
  return EXTENSION_TO_MIME[ext];
}

export function useImageAttachments(promptId?: string) {
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

  const addFiles = useCallback(
    (files: FileList | File[]) => {
      const fileArray = Array.from(files);
      const remaining = MAX_FILES - attachmentsRef.current.length;
      if (remaining <= 0) return;

      fileArray.slice(0, remaining).forEach((file) => {
        if (!ALLOWED_TYPES.includes(file.type)) return;
        if (file.size > MAX_SIZE_BYTES) return;

        const reader = new FileReader();
        reader.addEventListener("load", (e) => {
          const dataUrl = e.target?.result as string;
          const base64 = dataUrl.split(",")[1];
          const previewUrl = URL.createObjectURL(file);
          addAttachment({
            id: crypto.randomUUID(),
            fileName: file.name,
            base64,
            mimeType: file.type,
            previewUrl,
          });
        });
        reader.readAsDataURL(file);
      });
    },
    [addAttachment],
  );

  const addDroppedFiles = useCallback(
    async (files: FileDropItem[]) => {
      const remaining = MAX_FILES - attachmentsRef.current.length;
      if (remaining <= 0) return;

      for (const file of files.slice(0, remaining)) {
        const mimeType = getMimeFromExtension(file.name);
        if (!mimeType) {
          toast.error(`Unsupported file: ${file.name}`, {
            description: "Only PNG, JPEG, GIF, and WebP images can be attached.",
          });
          continue;
        }

        try {
          const base64 = await desktopBridge.readFileBase64(file.handle);
          const previewUrl = `data:${mimeType};base64,${base64}`;
          addAttachment({
            id: crypto.randomUUID(),
            fileName: file.name,
            base64,
            mimeType,
            previewUrl,
          });
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          toast.error(`Couldn't attach ${file.name}`, { description: message });
        }
      }
    },
    [addAttachment],
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
          toast.error("Drop the image on an agent to attach it.", {
            id: "image-drop-missing-target",
          });
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
      if (target) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((a) => a.id !== id);
    });
  }, []);

  const clearAttachments = useCallback((options?: { revokeObjectUrls?: boolean }) => {
    setAttachments((prev) => {
      if (options?.revokeObjectUrls !== false) {
        prev.forEach((a) => URL.revokeObjectURL(a.previewUrl));
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
