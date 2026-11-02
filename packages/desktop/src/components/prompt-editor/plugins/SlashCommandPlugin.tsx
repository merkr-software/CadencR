import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $getRoot, $getSelection, $isRangeSelection, $isTextNode, type TextNode } from "lexical";
import { $createSlashCommandNode } from "../nodes/SlashCommandNode";
import { SLASH_COMMAND_GROUP_ORDER, SlashCommandPopover } from "@/components/SlashCommandPopover";
import { useSlashCommand } from "@/hooks/useSlashCommand";
import { useProjectMcpEnabled, useWorkspaceMcpEnabled } from "@/lib/mcp-settings";
import type { PromptCommandTriggerChar } from "@/lib/prompt-command-policy";
import { isSlashCommandDisabled, type SlashCommand } from "@/lib/slash-command";
import {
  AnchoredPopover,
  getTriggerMatch,
  replaceTriggerWithNode,
  useComposerPopoverAnchor,
  usePopoverKeyboardCommands,
} from "./trigger-utils";

interface SlashCommandPluginProps {
  commands: SlashCommand[] | undefined;
  isLoading?: boolean;
  /** Why the provider's own commands could not be listed, if they could not. */
  error?: string | null;
  commandKindsAtPromptStart: readonly SlashCommand["kind"][];
  commandKindsMidPrompt: readonly SlashCommand["kind"][];
  triggerChar: PromptCommandTriggerChar;
}

/** Minimal view of the `useSlashCommand` hook the editor sync callback needs. */
interface TriggerSync {
  isOpen: boolean;
  close: () => void;
  handleChange: (text: string, cursor: number) => void;
}

function isAtPromptStart(node: TextNode, triggerOffset: number): boolean {
  return (
    triggerOffset === 0 &&
    node.getPreviousSibling() === null &&
    node.getParent() === $getRoot().getFirstChild()
  );
}

/** Re-derive the open/query state of the trigger popover from the current
 * editor selection. Read-only (runs inside `editorState.read`). */
function syncTriggerFromEditor(
  s: TriggerSync,
  triggerChar: PromptCommandTriggerChar,
  allowsMidPrompt: boolean,
  setAtPromptStart: (value: boolean) => void,
): void {
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
  const matchAtPromptStart = isAtPromptStart(node, match.triggerOffset);
  if (!matchAtPromptStart && !allowsMidPrompt) {
    if (s.isOpen) s.close();
    return;
  }
  setAtPromptStart(matchAtPromptStart);
  const syntheticText = triggerChar + match.query;
  s.handleChange(syntheticText, syntheticText.length);
}

export function SlashCommandPlugin({
  commands,
  isLoading,
  error,
  commandKindsAtPromptStart,
  commandKindsMidPrompt,
  triggerChar,
}: SlashCommandPluginProps) {
  const [editor] = useLexicalComposerContext();
  const [atPromptStart, setAtPromptStart] = useState(true);
  const atPromptStartRef = useRef(true);
  const updateAtPromptStart = useCallback((value: boolean) => {
    if (atPromptStartRef.current === value) return;
    atPromptStartRef.current = value;
    setAtPromptStart(value);
  }, []);
  const allowedCommandKinds = atPromptStart ? commandKindsAtPromptStart : commandKindsMidPrompt;
  // Group order first (stable within a group), so the unfiltered list reads
  // as Cadencr → skills → commands and keyboard order matches visual order.
  const filteredCommands = useMemo(
    () =>
      commands
        ?.filter((command) => allowedCommandKinds.includes(command.kind))
        .toSorted(
          (a, b) =>
            SLASH_COMMAND_GROUP_ORDER.indexOf(a.kind) - SLASH_COMMAND_GROUP_ORDER.indexOf(b.kind),
        ),
    [commands, allowedCommandKinds],
  );
  const listId = useId();
  // Cadencr virtual skills call both the project MCP (spawn/link/gates) and
  // the workspace MCP (session graph, project listing) tools, so both must be
  // on. When either is off the skills are shown but disabled (non-selectable)
  // rather than hidden.
  const { enabled: projectMcpEnabled } = useProjectMcpEnabled();
  const { enabled: workspaceMcpEnabled } = useWorkspaceMcpEnabled();
  const cadencrEnabled = projectMcpEnabled && workspaceMcpEnabled;
  const isDisabled = useCallback(
    (command: SlashCommand | undefined) => isSlashCommandDisabled(command, cadencrEnabled),
    [cadencrEnabled],
  );
  const slash = useSlashCommand(filteredCommands, triggerChar);
  const slashRef = useRef(slash);
  slashRef.current = slash;
  useEffect(() => {
    return editor.registerUpdateListener(({ editorState }) => {
      editorState.read(() =>
        syncTriggerFromEditor(
          slashRef.current,
          triggerChar,
          commandKindsMidPrompt.length > 0,
          updateAtPromptStart,
        ),
      );
    });
  }, [commandKindsMidPrompt.length, editor, triggerChar, updateAtPromptStart]);

  const handleSelect = useCallback(
    (commandName: string) => {
      const target = filteredCommands?.find((command) => command.name === commandName);
      if (isDisabled(target)) return; // disabled cadencr skill — ignore selection
      replaceTriggerWithNode(
        editor,
        triggerChar,
        (name) => $createSlashCommandNode(name, triggerChar),
        commandName,
        () => slashRef.current.close(),
      );
    },
    // `slashRef` is stable, so `onSelect` stays referentially stable and the
    // memoized `SlashCommandItem` rows don't re-render on every keystroke.
    [editor, triggerChar, filteredCommands, isDisabled],
  );

  const getSelectedValue = useCallback(() => {
    const s = slashRef.current;
    const item = s.filteredItems.length > 0 ? s.filteredItems[s.selectedIndex] : undefined;
    // Return undefined for a disabled skill so Enter/Tab fall through instead of
    // selecting it.
    return item && !isDisabled(item) ? item.name : undefined;
  }, [isDisabled]);

  usePopoverKeyboardCommands(
    editor,
    slash.isOpen,
    slashRef,
    getSelectedValue,
    handleSelect,
    listId,
  );

  // An error opens the menu even when nothing matched: an empty list would
  // read as "this provider has no commands".
  const popoverOpen = slash.isOpen && (!!isLoading || !!error || slash.filteredItems.length > 0);
  const popoverAnchor = useComposerPopoverAnchor(editor, popoverOpen);

  if (!popoverOpen || !popoverAnchor) return null;

  return (
    <AnchoredPopover anchor={popoverAnchor}>
      <SlashCommandPopover
        listId={listId}
        open={true}
        items={slash.filteredItems}
        selectedIndex={slash.selectedIndex}
        onSelect={handleSelect}
        isLoading={isLoading ?? false}
        error={error}
        triggerChar={triggerChar}
        cadencrDisabled={!cadencrEnabled}
        maxHeight={popoverAnchor.maxHeight}
      />
    </AnchoredPopover>
  );
}
