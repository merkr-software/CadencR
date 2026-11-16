import { useEffect } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { COMMAND_PRIORITY_NORMAL, PASTE_COMMAND } from "lexical";

/** A paste this long reads better as a context chip than as prompt prose. */
export const LONG_PASTE_MIN_LINES = 40;
export const LONG_PASTE_MIN_CHARS = 4000;

export function isLongPaste(text: string): boolean {
  return text.length >= LONG_PASTE_MIN_CHARS || text.split("\n").length >= LONG_PASTE_MIN_LINES;
}

/**
 * Turns a very long text paste (logs, a stack trace, a file) into a context
 * item instead of burying the user's own words under it. Images and shorter
 * pastes fall through to the other handlers.
 */
export function LongPastePlugin({ onPasteLongText }: { onPasteLongText?: (text: string) => void }) {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    if (!onPasteLongText) return;
    return editor.registerCommand(
      PASTE_COMMAND,
      (event) => {
        if (!event || !("clipboardData" in event) || !event.clipboardData) return false;
        const text = event.clipboardData.getData("text/plain");
        if (!text || !isLongPaste(text)) return false;
        event.preventDefault();
        onPasteLongText(text);
        return true;
      },
      COMMAND_PRIORITY_NORMAL,
    );
  }, [editor, onPasteLongText]);

  return null;
}
