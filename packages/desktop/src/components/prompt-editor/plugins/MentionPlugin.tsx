import { useCallback, useEffect, useId, useRef } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $getSelection, $isRangeSelection, $isTextNode } from "lexical";
import { $createMentionNode } from "../nodes/MentionNode";
import { FileMentionPopover } from "@/components/FileMentionPopover";
import { useFileMention } from "@/hooks/useFileMention";
import {
  getTriggerMatch,
  replaceTriggerWithNode,
  usePopoverKeyboardCommands,
  useComposerPopoverAnchor,
  AnchoredPopover,
} from "./trigger-utils";

interface MentionPluginProps {
  projectId: number | undefined;
  featureId: number | undefined;
}

export function MentionPlugin({ projectId, featureId }: MentionPluginProps) {
  const [editor] = useLexicalComposerContext();
  const mention = useFileMention({ projectId, featureId });
  const mentionRef = useRef(mention);
  mentionRef.current = mention;
  const listId = useId();

  useEffect(() => {
    return editor.registerUpdateListener(({ editorState }) => {
      editorState.read(() => {
        const m = mentionRef.current;
        const selection = $getSelection();
        if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
          if (m.isOpen) m.close();
          return;
        }

        const anchor = selection.anchor;
        const node = anchor.getNode();
        if (!$isTextNode(node)) {
          if (m.isOpen) m.close();
          return;
        }

        const match = getTriggerMatch(node, anchor.offset, "@");
        if (!match) {
          if (m.isOpen) m.close();
          return;
        }

        m.handleChange(node.getTextContent(), anchor.offset);
      });
    });
  }, [editor]);

  const handleSelect = useCallback(
    (path: string) => {
      replaceTriggerWithNode(editor, "@", $createMentionNode, path, () => mention.close());
    },
    [editor, mention],
  );

  const getSelectedValue = useCallback(() => {
    const m = mentionRef.current;
    return m.filteredItems.length > 0 ? m.filteredItems[m.selectedIndex].path : undefined;
  }, []);

  usePopoverKeyboardCommands(
    editor,
    mention.isOpen,
    mentionRef,
    getSelectedValue,
    handleSelect,
    listId,
  );
  const popoverOpen = mention.isOpen && mention.filteredItems.length > 0;
  const popoverAnchor = useComposerPopoverAnchor(editor, popoverOpen);

  if (!popoverOpen || !popoverAnchor) return null;

  return (
    <AnchoredPopover anchor={popoverAnchor}>
      <FileMentionPopover
        listId={listId}
        items={mention.filteredItems}
        selectedIndex={mention.selectedIndex}
        onSelect={handleSelect}
        maxHeight={popoverAnchor.maxHeight}
      />
    </AnchoredPopover>
  );
}
