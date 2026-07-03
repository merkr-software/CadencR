import { useCallback, useEffect, useMemo, useRef } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $getRoot, $getSelection, $isRangeSelection, $isTextNode } from "lexical";
import { $createSlashCommandNode } from "../nodes/SlashCommandNode";
import { SlashCommandPopover } from "@/components/SlashCommandPopover";
import { useSlashCommand, type SlashCommand } from "@/hooks/useSlashCommand";
import {
  getTriggerMatch,
  replaceTriggerWithNode,
  usePopoverKeyboardCommands,
} from "./trigger-utils";

interface SlashCommandPluginProps {
  commands: SlashCommand[] | undefined;
  isLoading?: boolean;
  commandKind?: SlashCommand["kind"];
  triggerChar?: "/" | "$";
}

export function SlashCommandPlugin({
  commands,
  isLoading,
  commandKind,
  triggerChar = "/",
}: SlashCommandPluginProps) {
  const [editor] = useLexicalComposerContext();
  const filteredCommands = useMemo(
    () => commands?.filter((command) => !commandKind || command.kind === commandKind),
    [commands, commandKind],
  );
  const slash = useSlashCommand(filteredCommands, triggerChar);
  const slashRef = useRef(slash);
  slashRef.current = slash;
  useEffect(() => {
    return editor.registerUpdateListener(({ editorState }) => {
      editorState.read(() => {
        const s = slashRef.current;
        const selection = $getSelection();
        if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
          if (s.isOpen) s.close();
          return;
        }

        const anchor = selection.anchor;
        const node = anchor.getNode();
        if (!$isTextNode(node)) {
          if (s.isOpen) s.close();
          return;
        }

        const match = getTriggerMatch(node, anchor.offset, triggerChar);
        if (!match) {
          if (s.isOpen) s.close();
          return;
        }

        // Slash commands ("/") only open at the very start of the editor.
        // Skills ("$") can appear anywhere and multiple times, like @ mentions.
        if (triggerChar === "/") {
          const isAtStart =
            match.triggerOffset === 0 &&
            node.getPreviousSibling() === null &&
            node.getParent() === $getRoot().getFirstChild();
          if (!isAtStart) {
            if (s.isOpen) s.close();
            return;
          }
        }

        const syntheticText = triggerChar + match.query;
        s.handleChange(syntheticText, syntheticText.length);
      });
    });
  }, [editor, triggerChar]);

  const handleSelect = useCallback(
    (commandName: string) => {
      replaceTriggerWithNode(
        editor,
        triggerChar,
        (name) => $createSlashCommandNode(name, triggerChar),
        commandName,
        () => slash.close(),
      );
    },
    [editor, slash, triggerChar],
  );

  const getSelectedValue = useCallback(() => {
    const s = slashRef.current;
    return s.filteredItems.length > 0 ? s.filteredItems[s.selectedIndex].name : undefined;
  }, []);

  usePopoverKeyboardCommands(editor, slash.isOpen, slashRef, getSelectedValue, handleSelect);

  if (!slash.isOpen || (!isLoading && slash.filteredItems.length === 0)) return null;

  return (
    <SlashCommandPopover
      open={true}
      items={slash.filteredItems}
      selectedIndex={slash.selectedIndex}
      onSelect={handleSelect}
      isLoading={isLoading ?? false}
      triggerChar={triggerChar}
    >
      <span />
    </SlashCommandPopover>
  );
}
