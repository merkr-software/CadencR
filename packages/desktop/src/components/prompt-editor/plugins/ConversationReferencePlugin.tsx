import { useCallback, useEffect, useId, useRef } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $getSelection, $isRangeSelection, $isTextNode, type LexicalEditor } from "lexical";
import { ConversationReferencePopover } from "@/components/ConversationReferencePopover";
import { useConversationReference } from "@/hooks/useConversationReference";
import { useWorkspaceMcpEnabled } from "@/lib/mcp-settings";
import { $createConversationReferenceNode } from "../nodes/ConversationReferenceNode";
import {
  AnchoredPopover,
  getTriggerMatch,
  replaceTriggerWithNode,
  useComposerPopoverAnchor,
  usePopoverKeyboardCommands,
} from "./trigger-utils";

export function ConversationReferencePlugin({
  currentFeatureId,
}: {
  currentFeatureId: number | undefined;
}) {
  const [editor] = useLexicalComposerContext();
  const { enabled } = useWorkspaceMcpEnabled();
  const reference = useConversationReference(currentFeatureId, enabled);
  const referenceRef = useRef(reference);
  referenceRef.current = reference;
  const listId = useId();
  useConversationTriggerSync(editor, referenceRef);

  const handleSelect = useCallback(
    (featureId: number) => {
      const item = referenceRef.current.filteredItems.find(
        (candidate) => candidate.feature_id === featureId,
      );
      if (!item || !enabled) return;
      replaceTriggerWithNode(
        editor,
        "@@",
        () =>
          $createConversationReferenceNode(
            item.feature_id,
            `${item.project_name} / ${item.feature_title}`,
          ),
        String(featureId),
        () => referenceRef.current.close(),
      );
    },
    [editor, enabled],
  );
  const getSelectedValue = useCallback(() => {
    const current = referenceRef.current;
    if (!enabled || current.filteredItems.length === 0) return null;
    return current.filteredItems[current.selectedIndex]?.feature_id ?? null;
  }, [enabled]);
  const selectValue = useCallback(
    (value: number | null) => {
      if (value !== null) handleSelect(value);
    },
    [handleSelect],
  );
  usePopoverKeyboardCommands(
    editor,
    reference.isOpen,
    referenceRef,
    getSelectedValue,
    selectValue,
    listId,
  );
  const popoverAnchor = useComposerPopoverAnchor(editor, reference.isOpen);

  if (!reference.isOpen || !popoverAnchor) return null;
  return (
    <AnchoredPopover anchor={popoverAnchor}>
      <ConversationReferencePopover
        listId={listId}
        maxHeight={popoverAnchor.maxHeight}
        items={reference.filteredItems}
        selectedIndex={reference.selectedIndex}
        isLoading={reference.isLoading}
        error={reference.isError ? reference.error : null}
        disabled={!enabled}
        onSelect={handleSelect}
      />
    </AnchoredPopover>
  );
}

/** Open/close/query the `@@` popover from the editor's selection. */
function useConversationTriggerSync(
  editor: LexicalEditor,
  referenceRef: { current: ReturnType<typeof useConversationReference> },
): void {
  const triggerPositionRef = useRef<string | null>(null);
  useEffect(
    () =>
      editor.registerUpdateListener(({ editorState }) => {
        editorState.read(() => {
          const current = referenceRef.current;
          const selection = $getSelection();
          if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
            triggerPositionRef.current = null;
            if (current.isOpen) current.close();
            return;
          }
          const anchor = selection.anchor;
          const node = anchor.getNode();
          if (!$isTextNode(node)) {
            triggerPositionRef.current = null;
            if (current.isOpen) current.close();
            return;
          }
          const match = getTriggerMatch(node, anchor.offset, "@@");
          if (!match) {
            triggerPositionRef.current = null;
            if (current.isOpen) current.close();
            return;
          }
          const triggerPosition = `${node.getKey()}:${anchor.offset}`;
          if (
            current.isOpen &&
            current.query === match.query &&
            triggerPositionRef.current === triggerPosition
          )
            return;
          triggerPositionRef.current = triggerPosition;
          current.updateQuery(match.query);
        });
      }),
    [editor],
  );
}
