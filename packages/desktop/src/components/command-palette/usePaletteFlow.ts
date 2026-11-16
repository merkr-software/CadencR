import { useCallback, useMemo, useState } from "react";
import type { ConversationIndexEntry } from "@/api/generated";
import {
  applyPaletteInput,
  nextScope,
  type PaletteMode,
  type PaletteScope,
} from "@/lib/command-palette/palette-query";
import { commandKey, conversationKey, projectKey } from "@/lib/command-palette/palette-ranking";
import type {
  PaletteCommand,
  PaletteEntry,
  PaletteStep,
} from "@/lib/command-palette/palette-types";
import type { PaletteOperations } from "./usePaletteOperations";

/** Where the palette is: the search, a result's actions, or a step of a flow. */
export type PaletteView =
  | { kind: "search" }
  | { kind: "actions"; entry: PaletteEntry; query: string }
  | { kind: "step"; step: PaletteStep };

interface Frame {
  view: PaletteView;
  mode: PaletteMode;
  text: string;
  selectedKey: string;
}

const SEARCH: PaletteView = { kind: "search" };

export interface PaletteFlowDeps {
  ops: PaletteOperations;
  activeFeatureId: number | null;
  conversations: readonly ConversationIndexEntry[];
  recordUse: (key: string) => void;
  /** Closes the palette, then runs `action` once focus is back in the app. */
  finish: (action?: () => void) => void;
}

/**
 * The palette's state machine. Actions and steps push a frame, so Esc or
 * Backspace in an empty field returns to exactly the search (text, mode,
 * selection) the user left.
 */
export function usePaletteFlow(deps: PaletteFlowDeps) {
  const [frame, setFrame] = useState<Frame>({
    view: SEARCH,
    mode: "all",
    text: "",
    selectedKey: "",
  });
  const [stack, setStack] = useState<readonly Frame[]>([]);
  const [scope, setScope] = useState<PaletteScope>("all");

  const push = useCallback(
    (view: PaletteView) => {
      setStack((current) => [...current, frame]);
      setFrame({ view, mode: "all", text: "", selectedKey: "" });
    },
    [frame],
  );

  /** One step back; `false` when already at the plain search (Esc then closes). */
  const back = useCallback((): boolean => {
    const previous = stack.at(-1);
    if (previous) {
      setStack(stack.slice(0, -1));
      setFrame(previous);
      return true;
    }
    if (frame.mode !== "all") {
      setFrame({ ...frame, mode: "all", selectedKey: "" });
      return true;
    }
    return false;
  }, [frame, stack]);

  const setText = useCallback((value: string) => {
    setFrame((current) => {
      if (current.view.kind !== "search") return { ...current, text: value, selectedKey: "" };
      const next = applyPaletteInput(current.mode, value);
      return { ...current, mode: next.mode, text: next.text, selectedKey: "" };
    });
  }, []);

  const setMode = useCallback((mode: PaletteMode, text = "") => {
    setStack([]);
    setFrame({ view: SEARCH, mode, text, selectedKey: "" });
  }, []);

  const setSelectedKey = useCallback((selectedKey: string) => {
    setFrame((current) =>
      current.selectedKey === selectedKey ? current : { ...current, selectedKey },
    );
  }, []);

  const { pick, activate } = usePick(deps, frame, push, setMode);

  const cycleScope = useCallback(
    (hasProject: boolean) => setScope((current) => nextScope(current, hasProject)),
    [],
  );

  return useMemo(
    () => ({
      view: frame.view,
      mode: frame.mode,
      text: frame.text,
      selectedKey: frame.selectedKey,
      scope,
      setScope,
      setText,
      setMode,
      setSelectedKey,
      push,
      back,
      pick,
      activate,
      cycleScope,
    }),
    [activate, back, cycleScope, frame, pick, push, scope, setMode, setSelectedKey, setText],
  );
}

/** What choosing a row does, by kind: open, run, switch mode, or step into a flow. */
function usePick(
  deps: PaletteFlowDeps,
  frame: Frame,
  push: (view: PaletteView) => void,
  setMode: (mode: PaletteMode, text?: string) => void,
) {
  const { ops, activeFeatureId, conversations, recordUse, finish } = deps;
  const runCommand = useCallback(
    (command: PaletteCommand, remember: boolean) => {
      if (remember) recordUse(commandKey(command.id));
      if (command.stay) command.stay();
      else if (command.mode) setMode(command.mode);
      else if (command.step) push({ kind: "step", step: command.step });
      else finish(command.run ? () => void command.run?.() : undefined);
    },
    [finish, push, recordUse, setMode],
  );

  /** Choosing `entry` from the search; `query` is the text it was found with. */
  const activate = useCallback(
    (entry: PaletteEntry, query: string) => {
      switch (entry.kind) {
        case "conversation": {
          const { conversation } = entry;
          recordUse(conversationKey(conversation.id));
          finish(() => ops.openConversation(conversation.project_id, conversation.id));
          return;
        }
        case "project": {
          const { project } = entry;
          recordUse(projectKey(project.id));
          const latest = conversations.find(
            (conversation) =>
              conversation.project_id === project.id && conversation.status === "active",
          );
          if (latest) finish(() => ops.openConversation(project.id, latest.id));
          else push({ kind: "step", step: { kind: "worktree", projectId: project.id } });
          return;
        }
        case "command":
          runCommand(entry.command, true);
          return;
        case "file":
          if (activeFeatureId != null) finish(() => ops.openFile(activeFeatureId, entry.path));
          return;
        case "message":
          recordUse(conversationKey(entry.hit.feature_id));
          finish(() => ops.openMessage(entry.hit, query));
          return;
      }
    },
    [activeFeatureId, conversations, finish, ops, push, recordUse, runCommand],
  );

  /** Steps and action lists pick projects (a step) and commands (not ranked by use) differently. */
  const pick = useCallback(
    (entry: PaletteEntry) => {
      if (frame.view.kind !== "search" && entry.kind === "project") {
        push({ kind: "step", step: { kind: "worktree", projectId: entry.project.id } });
      } else if (frame.view.kind !== "search" && entry.kind === "command") {
        runCommand(entry.command, false);
      } else {
        activate(entry, frame.text.trim());
      }
    },
    [activate, frame.text, frame.view.kind, push, runCommand],
  );

  return { pick, activate };
}

export type PaletteFlow = ReturnType<typeof usePaletteFlow>;
