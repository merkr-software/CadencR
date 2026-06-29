import { useEffect } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { COMMAND_PRIORITY_HIGH, KEY_SPACE_COMMAND, TextNode } from "lexical";
import {
  getUnifiedAgentsFilterActiveToken,
  insertPlainSpaceAfterFilterToken,
  normalizeUnifiedAgentsFilterTextNode,
} from "@/components/UnifiedAgentsFilterEditorText";

/** Reports the `/key:` token under the cursor so the suggestions menu can open. */
export function SlashFilterCursorPlugin({
  onTokenChange,
}: {
  onTokenChange: (token: string | null) => void;
}): null {
  const [editor] = useLexicalComposerContext();
  useEffect(
    () =>
      editor.registerUpdateListener(({ editorState }) => {
        editorState.read(() => onTokenChange(getUnifiedAgentsFilterActiveToken()?.text ?? null));
      }),
    [editor, onTokenChange],
  );
  return null;
}

/** Inserts an unstyled space after a filter token so the next word isn't
 *  swallowed into the token's styling. */
export function PlainSpaceAfterFilterTokenPlugin(): null {
  const [editor] = useLexicalComposerContext();
  useEffect(
    () =>
      editor.registerCommand(
        KEY_SPACE_COMMAND,
        (event: KeyboardEvent): boolean => {
          const handled = insertPlainSpaceAfterFilterToken();
          if (!handled) return false;
          event.preventDefault();
          return true;
        },
        COMMAND_PRIORITY_HIGH,
      ),
    [editor],
  );
  return null;
}

/** Restyles text nodes as recognized `/key:value` tokens as the user types. */
export function FilterTextNodeNormalizationPlugin(): null {
  const [editor] = useLexicalComposerContext();
  useEffect(
    () => editor.registerNodeTransform(TextNode, normalizeUnifiedAgentsFilterTextNode),
    [editor],
  );
  return null;
}
