import { useCallback, useEffect, useMemo, useState, type RefObject } from "react";
import type { UnifiedAgentsFilterInputHandle } from "@/components/UnifiedAgentsDynamicFilter";
import type { UnifiedAgentsData } from "@/components/UnifiedAgentsViewData";
import type { useUnifiedAgentPinControls } from "@/components/useUnifiedAgentPinControls";
import { useGlobalShortcutById } from "@/hooks/useShortcut";

interface ActiveAgentState {
  activeIndex: number;
  activeAgent: UnifiedAgentsData["agents"][number] | null;
  setActiveSessionId: (sessionId: number | null) => void;
}

export function useActiveAgent(agents: UnifiedAgentsData["agents"]): ActiveAgentState {
  // `null` follows the first card: until the user picks one, the active card
  // is whichever agent sorts first, even as the order settles on load.
  const [activeSessionId, setActiveSessionId] = useState<number | null>(null);
  const activeIndex = resolveActiveIndex(agents, activeSessionId);
  const activeAgent = agents[activeIndex] ?? null;

  useEffect(() => {
    if (activeSessionId === null) return;
    if (agents.some((entry) => entry.session.sessionDbId === activeSessionId)) return;
    setActiveSessionId(null);
  }, [activeSessionId, agents]);

  return useMemo(
    () => ({ activeIndex, activeAgent, setActiveSessionId }),
    [activeIndex, activeAgent],
  );
}

interface UnifiedAgentsKeyboardArgs {
  agents: UnifiedAgentsData["agents"];
  columns: number;
  activeIndex: number;
  activePinControls: ReturnType<typeof useUnifiedAgentPinControls>;
  hideAgent: (title: string) => void;
  searchInputRef: RefObject<UnifiedAgentsFilterInputHandle | null>;
  setActiveSessionId: (sessionId: number | null) => void;
}

interface UnifiedAgentsKeyboardState {
  focusVersion: number;
  focusFirstMatchedAgent: () => void;
}

export function useUnifiedAgentsKeyboard({
  agents,
  columns,
  activeIndex,
  activePinControls,
  hideAgent,
  searchInputRef,
  setActiveSessionId,
}: UnifiedAgentsKeyboardArgs): UnifiedAgentsKeyboardState {
  const [focusVersion, setFocusVersion] = useState(0);
  const focusFirstMatchedAgent = useCallback((): void => {
    if (agents.length === 0) return;
    searchInputRef.current?.blur();
    setActiveSessionId(agents[0].session.sessionDbId);
    setFocusVersion((current) => current + 1);
  }, [agents, searchInputRef, setActiveSessionId]);

  const moveFocus = useCallback(
    (direction: "left" | "right" | "up" | "down"): void => {
      if (agents.length === 0) return;
      const next = nextAgentIndex(activeIndex, direction, agents.length, columns);
      if (next === activeIndex) return;
      setActiveSessionId(agents[next]?.session.sessionDbId ?? null);
      setFocusVersion((current) => current + 1);
    },
    [activeIndex, agents, columns, setActiveSessionId],
  );

  // Window-level capture-phase listeners so navigation/pin work even when
  // focus is inside an xterm or CodeMirror (which stopPropagation native
  // keydown before React's delegated listeners see it).
  useGlobalShortcutById("agents-navigate-left", (e) => {
    consumeKeyEvent(e);
    moveFocus("left");
  });
  useGlobalShortcutById("agents-navigate-right", (e) => {
    consumeKeyEvent(e);
    moveFocus("right");
  });
  useGlobalShortcutById("agents-navigate-up", (e) => {
    consumeKeyEvent(e);
    moveFocus("up");
  });
  useGlobalShortcutById("agents-navigate-down", (e) => {
    consumeKeyEvent(e);
    moveFocus("down");
  });
  useGlobalShortcutById("agents-pin", (e) => {
    consumeKeyEvent(e);
    activePinControls.toggle();
  });
  useGlobalShortcutById("agents-hide", (e) => {
    consumeKeyEvent(e);
    const title = agents[activeIndex]?.feature.title;
    if (title) hideAgent(title);
  });

  useGlobalShortcutById("agents-search", (e) => {
    consumeKeyEvent(e);
    searchInputRef.current?.focus();
  });

  return useMemo(
    () => ({ focusVersion, focusFirstMatchedAgent }),
    [focusVersion, focusFirstMatchedAgent],
  );
}

function consumeKeyEvent(event: KeyboardEvent): void {
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
}

function nextAgentIndex(
  index: number,
  direction: "left" | "right" | "up" | "down",
  total: number,
  columns: number,
): number {
  if (total === 0) return 0;
  if (direction === "left") return Math.max(0, index - 1);
  if (direction === "right") return Math.min(total - 1, index + 1);
  if (direction === "up") return Math.max(0, index - columns);
  return Math.min(total - 1, index + columns);
}

function resolveActiveIndex(
  agents: UnifiedAgentsData["agents"],
  activeSessionId: number | null,
): number {
  if (agents.length === 0) return 0;
  if (activeSessionId === null) return 0;
  const index = agents.findIndex((entry) => entry.session.sessionDbId === activeSessionId);
  return index >= 0 ? index : 0;
}
