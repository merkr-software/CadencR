import { useEffect } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { COMMAND_PRIORITY_NORMAL, PASTE_COMMAND } from "lexical";
import { classifyAttachment } from "@/lib/prompt-attachments";

interface ImagePastePluginProps {
  /** Receives attachable files (images or text) pasted as file items. */
  onPasteImages?: (files: File[]) => void;
}

function extractAttachableFiles(clipboardData: DataTransfer | null): File[] {
  if (!clipboardData) return [];
  const files: File[] = [];
  for (const item of clipboardData.items) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (!file) continue;
    if (classifyAttachment(file.name, file.type).kind === "unsupported") continue;
    files.push(file);
  }
  return files;
}

/**
 * Forwards attachable files (images, CSV/text) from clipboard pastes to
 * `onPasteImages`; plain-text pastes (no file items) fall through to the editor.
 */
export function ImagePastePlugin({ onPasteImages }: ImagePastePluginProps) {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    if (!onPasteImages) return;
    return editor.registerCommand(
      PASTE_COMMAND,
      (event) => {
        if (!event || !("clipboardData" in event)) return false;
        const attachable = extractAttachableFiles(event.clipboardData);
        if (attachable.length === 0) return false;
        event.preventDefault();
        onPasteImages(attachable);
        return true;
      },
      COMMAND_PRIORITY_NORMAL,
    );
  }, [editor, onPasteImages]);

  return null;
}
