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
  const [isDragging, setIsDragging] = useState(false);
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;

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

  // Listen for OS-level file drops (e.g. from Finder).
  useEffect(() => {
    return desktopBridge.onFileDrop((event) => {
      if (event.type === "enter") {
        setIsDragging(true);
      } else if (event.type === "leave") {
        setIsDragging(false);
      } else if (event.type === "drop") {
        setIsDragging(false);
        if (!event.targetPromptId) {
          toast.error("Drop an image directly on an agent prompt.");
          return;
        }
        if (promptId && event.targetPromptId !== promptId) return;
        void addDroppedFilesRef.current(event.files);
      } else if (event.type === "error") {
        setIsDragging(false);
        toast.error("Couldn't read dropped files.", {
          description: event.message ?? "The desktop shell rejected the dropped file paths.",
        });
      }
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

  // React-level handlers — still needed for visual drag feedback.
  // Note: Desktop shell intercepts OS file drops, so onDrop won't receive files
  // from Finder. But we preventDefault to avoid browser default behavior.
  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
  }, []);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
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
