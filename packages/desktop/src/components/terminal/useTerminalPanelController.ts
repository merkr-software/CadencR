import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ForwardedRef,
} from "react";
import { toast } from "sonner";
import { useIsMobile } from "@/hooks/useIsMobile";
import {
  findAdjacentLeaf,
  getLeaves,
  useTerminalStore,
  type SplitOrientation,
  type TerminalPanelState,
} from "@/hooks/useTerminalState";
import { useWorktreeTerminalAutoSwitch } from "@/hooks/useWorktreeTerminalAutoSwitch";
import { useMonoFont } from "@/lib/fonts/mono-font-setting";
import type { TerminalCoreInstanceHandle } from "@/components/terminal-core";
import {
  useTerminalCopyPasteShortcuts,
  useTerminalPaneShortcuts,
} from "./useTerminalPaneShortcuts";

export interface TerminalPanelProps {
  featureId: number;
  projectId: number;
  state: TerminalPanelState;
  splitPane: (leafId: string | undefined, orientation: SplitOrientation) => string | null;
  removePane: (paneId: string) => void;
  expectedCwd: string | null;
  hotkeysEnabled?: boolean;
}

export interface TerminalPanelHandle {
  focusActivePane: () => void;
  focusFirstPane: () => void;
}

type TerminalLeaves = ReturnType<typeof getLeaves>;

function createSlotElement(id: string): HTMLDivElement {
  const element = document.createElement("div");
  element.style.flex = "1 1 0";
  element.style.minHeight = "0";
  element.style.width = "100%";
  element.setAttribute("data-pane-slot", id);
  return element;
}

function useTerminalSlots(leaves: TerminalLeaves) {
  const slotsRef = useRef<Map<string, HTMLDivElement>>(new Map());
  const placeholderRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const getSlot = useCallback((id: string): HTMLDivElement => {
    let slot = slotsRef.current.get(id);
    if (!slot) {
      slot = createSlotElement(id);
      slotsRef.current.set(id, slot);
    }
    return slot;
  }, []);
  const activeSlots = useMemo(
    () => leaves.map((leaf) => ({ leaf, slot: getSlot(leaf.id) })),
    [getSlot, leaves],
  );
  useEffect(() => {
    const activeIds = new Set(leaves.map((leaf) => leaf.id));
    for (const [id, element] of slotsRef.current) {
      if (activeIds.has(id)) continue;
      element.remove();
      slotsRef.current.delete(id);
    }
  }, [leaves]);
  const registerPlaceholder = useCallback((id: string, element: HTMLDivElement | null): void => {
    if (!element) {
      placeholderRefs.current.delete(id);
      return;
    }
    placeholderRefs.current.set(id, element);
    // Attach as soon as the anchor exists rather than waiting for the effect
    // below: that one only re-runs when `activeSlots` changes identity, so an
    // anchor mounting in a later commit never gets its slot. Split panes do
    // exactly that — they render inside a ResizablePanelGroup instead of
    // directly — which left them blank on remount.
    const slot = slotsRef.current.get(id);
    if (slot && slot.parentNode !== element) element.appendChild(slot);
  }, []);
  useLayoutEffect(() => {
    for (const { leaf, slot } of activeSlots) {
      const placeholder = placeholderRefs.current.get(leaf.id);
      if (placeholder && slot.parentNode !== placeholder) placeholder.appendChild(slot);
    }
  }, [activeSlots]);
  return useMemo(() => ({ activeSlots, registerPlaceholder }), [activeSlots, registerPlaceholder]);
}

function useTerminalPaneFocus(leaves: TerminalLeaves) {
  const paneRefs = useRef<Map<string, TerminalCoreInstanceHandle>>(new Map());
  const [activePaneId, setActivePaneId] = useState<string | null>(null);
  const [ctrlArmed, setCtrlArmed] = useState(false);
  const setPaneRef = useCallback(
    (paneId: string, handle: TerminalCoreInstanceHandle | null): void => {
      if (handle) paneRefs.current.set(paneId, handle);
      else paneRefs.current.delete(paneId);
    },
    [],
  );
  const setActivePane = useCallback((paneId: string): void => {
    setActivePaneId(paneId);
    for (const [id, handle] of paneRefs.current) {
      if (id !== paneId) handle.blur();
    }
  }, []);
  const focusPane = useCallback(
    (paneId: string): void => {
      paneRefs.current.get(paneId)?.focus();
      setActivePane(paneId);
    },
    [setActivePane],
  );
  const focusPaneByIndex = useCallback(
    (index: number): void => {
      if (leaves.length === 0) return;
      const leaf = leaves[Math.max(0, Math.min(leaves.length - 1, index))];
      if (leaf) focusPane(leaf.id);
    },
    [focusPane, leaves],
  );
  const activeIndex = Math.max(
    0,
    leaves.findIndex((leaf) => leaf.id === activePaneId),
  );
  const resolvedActivePaneId = leaves[activeIndex]?.id ?? null;
  const sendKeyToActivePane = useCallback(
    (sequence: string): void => {
      const id = resolvedActivePaneId ?? leaves[0]?.id;
      if (id) paneRefs.current.get(id)?.write(sequence);
      setCtrlArmed(false);
    },
    [leaves, resolvedActivePaneId],
  );
  const consumeCtrl = useCallback((): void => setCtrlArmed(false), []);
  const focusFirstPane = useCallback((): void => focusPaneByIndex(0), [focusPaneByIndex]);
  const toggleCtrl = useCallback((): void => setCtrlArmed((armed) => !armed), []);
  return useMemo(
    () => ({
      activeIndex,
      consumeCtrl,
      ctrlArmed,
      focusFirstPane,
      focusPane,
      focusPaneByIndex,
      paneRefs,
      resolvedActivePaneId,
      sendKeyToActivePane,
      setActivePane,
      setPaneRef,
      toggleCtrl,
    }),
    [
      activeIndex,
      consumeCtrl,
      ctrlArmed,
      focusFirstPane,
      focusPane,
      focusPaneByIndex,
      resolvedActivePaneId,
      sendKeyToActivePane,
      setActivePane,
      setPaneRef,
      toggleCtrl,
    ],
  );
}

type PaneFocus = ReturnType<typeof useTerminalPaneFocus>;

function useTerminalLayoutActions(
  props: TerminalPanelProps,
  leaves: TerminalLeaves,
  focus: PaneFocus,
) {
  const {
    hotkeysEnabled = true,
    removePane,
    splitPane,
    state: { root },
  } = props;
  const leavesRef = useRef(leaves);
  leavesRef.current = leaves;
  const splitPaneAndFocus = useCallback(
    (paneId: string | undefined, orientation: SplitOrientation): void => {
      const newId = splitPane(paneId, orientation);
      if (newId) requestAnimationFrame(() => focus.focusPane(newId));
    },
    [focus.focusPane, splitPane],
  );
  const splitAndFocus = useCallback(
    (orientation: SplitOrientation): void =>
      splitPaneAndFocus(focus.resolvedActivePaneId ?? undefined, orientation),
    [focus.resolvedActivePaneId, splitPaneAndFocus],
  );
  const navigatePane = useCallback(
    (direction: "left" | "right" | "up" | "down"): void => {
      if (!root || !focus.resolvedActivePaneId) return;
      const target = findAdjacentLeaf(root, focus.resolvedActivePaneId, direction);
      if (target) focus.focusPane(target);
    },
    [focus.focusPane, focus.resolvedActivePaneId, root],
  );
  const closePane = useCallback(
    (paneId: string): void => {
      focus.paneRefs.current.get(paneId)?.markForKill();
      const currentLeaves = leavesRef.current;
      const index = currentLeaves.findIndex((leaf) => leaf.id === paneId);
      const neighbor = currentLeaves[index > 0 ? index - 1 : index + 1];
      removePane(paneId);
      if (neighbor) requestAnimationFrame(() => focus.focusPane(neighbor.id));
    },
    [focus.focusPane, focus.paneRefs, removePane],
  );
  const closeActivePane = useCallback((): void => {
    if (focus.resolvedActivePaneId) closePane(focus.resolvedActivePaneId);
  }, [closePane, focus.resolvedActivePaneId]);
  useTerminalPaneShortcuts({
    hotkeysEnabled,
    resolvedActivePaneId: focus.resolvedActivePaneId,
    paneRefs: focus.paneRefs,
    onSplit: splitAndFocus,
    onNavigate: navigatePane,
    onClose: closePane,
  });
  return useMemo(
    () => ({ closeActivePane, closePane, splitAndFocus, splitPaneAndFocus }),
    [closeActivePane, closePane, splitAndFocus, splitPaneAndFocus],
  );
}

type LayoutActions = ReturnType<typeof useTerminalLayoutActions>;

function useTerminalRuntimeActions(
  props: TerminalPanelProps,
  leaves: TerminalLeaves,
  focus: PaneFocus,
  layout: LayoutActions,
) {
  const { expectedCwd, featureId, hotkeysEnabled = true } = props;
  const dismissCwdWarning = useTerminalStore((state) => state.dismissCwdWarning);
  const replaceLeafWithFresh = useTerminalStore((state) => state.replaceLeafWithFresh);
  const copyPaneSelection = useCallback(
    async (paneId: string): Promise<void> => {
      // No DOM selection to hand `execCommand` — the terminal draws to a
      // WebGPU canvas, so the text lives only in celeritty's own selection
      // buffer.
      const text = focus.paneRefs.current.get(paneId)?.getSelection() ?? null;
      if (!text) {
        toast.error("No terminal selection to copy");
        return;
      }
      try {
        await navigator.clipboard.writeText(text);
        toast.success("Terminal selection copied");
      } catch {
        toast.error("Failed to copy to clipboard");
      }
    },
    [focus.paneRefs],
  );
  const pasteIntoPane = useCallback(
    async (paneId: string): Promise<void> => {
      try {
        const text = await navigator.clipboard.readText();
        // `write` is local-only injection (used for initialNotice) and never
        // reaches the shell — `paste` sends it through the PTY, as if typed.
        if (text) focus.paneRefs.current.get(paneId)?.paste(text);
      } catch {
        toast.error("Failed to paste from clipboard");
      }
    },
    [focus.paneRefs],
  );
  useTerminalCopyPasteShortcuts({
    hotkeysEnabled,
    resolvedActivePaneId: focus.resolvedActivePaneId,
    onCopy: copyPaneSelection,
    onPaste: pasteIntoPane,
  });
  const restartPane = useCallback(
    (paneId: string): void => {
      focus.paneRefs.current.get(paneId)?.markForKill();
      replaceLeafWithFresh(featureId, paneId, expectedCwd ?? undefined);
    },
    [expectedCwd, featureId, focus.paneRefs, replaceLeafWithFresh],
  );
  const warnPaneIds = useWorktreeTerminalAutoSwitch({
    featureId,
    expectedCwd,
    leaves,
    onRestartPane: restartPane,
  });
  const dismissPaneWarning = useCallback(
    (paneId: string): void => dismissCwdWarning(featureId, paneId),
    [dismissCwdWarning, featureId],
  );
  const handlePaneExit = useCallback(
    (_ptyId: string, paneId: string): void => {
      setTimeout(() => layout.closePane(paneId), 500);
    },
    [layout.closePane],
  );
  return useMemo(
    () => ({
      copyPaneSelection,
      dismissPaneWarning,
      handlePaneExit,
      pasteIntoPane,
      restartPane,
      warnPaneIds,
    }),
    [
      copyPaneSelection,
      dismissPaneWarning,
      handlePaneExit,
      pasteIntoPane,
      restartPane,
      warnPaneIds,
    ],
  );
}

export function useTerminalPanelController(
  props: TerminalPanelProps,
  ref: ForwardedRef<TerminalPanelHandle>,
) {
  const leaves = useMemo(
    () => (props.state.root ? getLeaves(props.state.root) : []),
    [props.state.root],
  );
  const focus = useTerminalPaneFocus(leaves);
  const slots = useTerminalSlots(leaves);
  const layout = useTerminalLayoutActions(props, leaves, focus);
  const runtime = useTerminalRuntimeActions(props, leaves, focus, layout);
  const setPtyId = useTerminalStore((state) => state.setPtyId);
  const setPaneCwd = useTerminalStore((state) => state.setPaneCwd);
  const clearInitialCommand = useTerminalStore((state) => state.clearInitialCommand);
  const clearInitialNotice = useTerminalStore((state) => state.clearInitialNotice);
  useImperativeHandle(
    ref,
    () => ({
      focusActivePane: () => focus.focusPaneByIndex(focus.activeIndex),
      focusFirstPane: focus.focusFirstPane,
    }),
    [focus.activeIndex, focus.focusFirstPane, focus.focusPaneByIndex],
  );
  const isMobile = useIsMobile();
  const { family: monoFontFamily } = useMonoFont();
  return useMemo(
    () => ({
      clearInitialCommand,
      clearInitialNotice,
      focus,
      isMobile,
      layout,
      leaves,
      monoFontFamily,
      runtime,
      setPaneCwd,
      setPtyId,
      slots,
    }),
    [
      clearInitialCommand,
      clearInitialNotice,
      focus,
      isMobile,
      layout,
      leaves,
      monoFontFamily,
      runtime,
      setPaneCwd,
      setPtyId,
      slots,
    ],
  );
}

export type TerminalPanelController = ReturnType<typeof useTerminalPanelController>;
