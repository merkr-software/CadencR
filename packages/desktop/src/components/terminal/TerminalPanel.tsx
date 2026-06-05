import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useScopedGlobalShortcutById } from "@/hooks/useShortcut";
import { useIsMobile } from "@/hooks/useIsMobile";
import { XTermInstance, type XTermInstanceHandle } from "./XTermInstance";
import { TerminalPaneToolbar } from "./TerminalPaneToolbar";
import { MobileTerminalKeyBar } from "./MobileTerminalKeyBar";
import { TerminalSplitTree } from "./TerminalSplitTree";
import {
  type TerminalPanelState,
  type SplitOrientation,
  getLeaves,
  findAdjacentLeaf,
  useTerminalStore,
} from "@/hooks/useTerminalState";
import { useTheme } from "@/hooks/useTheme";

interface TerminalPanelProps {
  featureId: number;
  projectId: number;
  state: TerminalPanelState;
  splitPane: (leafId: string | undefined, orientation: SplitOrientation) => string | null;
  removePane: (paneId: string) => void;
  /** Working directory the feature currently expects (worktree path or project root). */
  expectedCwd: string | null;
  hotkeysEnabled?: boolean;
}

export interface TerminalPanelHandle {
  focusActivePane: () => void;
  focusFirstPane: () => void;
}

function createSlotElement(id: string): HTMLDivElement {
  const el = document.createElement("div");
  el.style.flex = "1 1 0";
  el.style.minHeight = "0";
  el.style.width = "100%";
  el.setAttribute("data-pane-slot", id);
  return el;
}

export const TerminalPanel = forwardRef<TerminalPanelHandle, TerminalPanelProps>(
  function TerminalPanel(
    { featureId, projectId, state, splitPane, removePane, expectedCwd, hotkeysEnabled = true },
    ref,
  ) {
    const { isMinimized, root } = state;
    const isMobile = useIsMobile();
    const leaves = useMemo(() => (root ? getLeaves(root) : []), [root]);
    const paneRefs = useRef<Map<string, XTermInstanceHandle>>(new Map());
    const [activePaneId, setActivePaneId] = useState<string | null>(null);
    // Sticky Ctrl for the mobile key bar: armed on tap, consumed by the next
    // keystroke in the focused pane (see XTermInstance's onData handler).
    const [ctrlArmed, setCtrlArmed] = useState(false);
    const consumeCtrl = useCallback(() => setCtrlArmed(false), []);
    const toggleCtrl = useCallback(() => setCtrlArmed((v) => !v), []);
    // xterm canvas can't read CSS vars — feed the palette in as a prop.
    const { theme } = useTheme();
    const xtermPalette = theme.xterm;
    const setPtyId = useTerminalStore((s) => s.setPtyId);
    const setPaneCwd = useTerminalStore((s) => s.setPaneCwd);
    const dismissCwdWarning = useTerminalStore((s) => s.dismissCwdWarning);
    const replaceLeafWithFresh = useTerminalStore((s) => s.replaceLeafWithFresh);
    const clearInitialCommand = useTerminalStore((s) => s.clearInitialCommand);

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

    const activeSlots = leaves.map((leaf) => ({ leaf, slot: getSlot(leaf.id) }));

    // Remove slots for leaves that no longer exist. We intentionally avoid an
    // unmount cleanup that clears the whole Map because StrictMode can run it
    // mid-life and make React portal xterm into a duplicate blank slot.
    useEffect(() => {
      const activeIds = new Set(leaves.map((l) => l.id));
      for (const [id, el] of slotsRef.current) {
        if (!activeIds.has(id)) {
          el.remove();
          slotsRef.current.delete(id);
        }
      }
    }, [leaves]);

    const setPaneRef = useCallback((paneId: string, handle: XTermInstanceHandle | null) => {
      if (handle) paneRefs.current.set(paneId, handle);
      else paneRefs.current.delete(paneId);
    }, []);

    /** Blur all terminals except the given one, and update active state */
    const setActivePane = useCallback((paneId: string) => {
      setActivePaneId(paneId);
      for (const [id, handle] of paneRefs.current) {
        if (id !== paneId) handle.blur();
      }
    }, []);

    const focusPane = useCallback(
      (paneId: string) => {
        paneRefs.current.get(paneId)?.focus();
        setActivePane(paneId);
      },
      [setActivePane],
    );

    const focusPaneByIndex = useCallback(
      (index: number) => {
        if (leaves.length === 0) return;
        const clamped = Math.max(0, Math.min(leaves.length - 1, index));
        const leaf = leaves[clamped];
        if (leaf) focusPane(leaf.id);
      },
      [leaves, focusPane],
    );

    const focusFirstPane = useCallback(() => focusPaneByIndex(0), [focusPaneByIndex]);

    const activeIndex = Math.max(
      0,
      leaves.findIndex((l) => l.id === activePaneId),
    );
    const resolvedActivePaneId = leaves[activeIndex]?.id ?? null;

    // Mobile key bar: send a fixed sequence (Esc/Tab/arrows) to the focused
    // pane. These keys don't combine with Ctrl, so tapping one also disarms it.
    const sendKeyToActivePane = useCallback(
      (seq: string) => {
        const id = resolvedActivePaneId ?? leaves[0]?.id;
        if (id) paneRefs.current.get(id)?.write(seq);
        setCtrlArmed(false);
      },
      [resolvedActivePaneId, leaves],
    );

    useImperativeHandle(
      ref,
      () => ({
        focusActivePane: () => focusPaneByIndex(activeIndex),
        focusFirstPane,
      }),
      [activeIndex, focusPaneByIndex, focusFirstPane],
    );

    // -- Keyboard shortcuts --
    // All terminal pane shortcuts are scoped to the terminal tab so they
    // don't fire when the user has another tab focused.
    //
    // We use the *global* capture-phase variant rather than `useHotkeys` so
    // the shortcuts still fire while xterm's textarea has focus.
    // Bubble-phase hotkeys can be swallowed by xterm before they reach app
    // handlers; capture phase keeps split shortcuts alive in the terminal.

    // Helper: split + focus the newly-created pane. The store returns the new
    // leaf id; we focus it on the next rAF so React has had a chance to mount
    // the new XTermInstance and register its imperative handle. The
    // `XTermInstance.focus()` method itself queues the request when xterm
    // isn't fully opened yet, so even a single rAF is enough.
    const splitAndFocus = useCallback(
      (orientation: SplitOrientation) => {
        const newId = splitPane(resolvedActivePaneId ?? undefined, orientation);
        if (!newId) return;
        requestAnimationFrame(() => focusPane(newId));
      },
      [splitPane, resolvedActivePaneId, focusPane],
    );

    useScopedGlobalShortcutById(
      "terminal-split-h",
      (e) => {
        e.preventDefault();
        e.stopPropagation();
        splitAndFocus("horizontal");
      },
      "terminal",
      { enabled: hotkeysEnabled },
    );

    useScopedGlobalShortcutById(
      "terminal-split-v",
      (e) => {
        e.preventDefault();
        e.stopPropagation();
        splitAndFocus("vertical");
      },
      "terminal",
      { enabled: hotkeysEnabled },
    );

    const navigatePane = useCallback(
      (direction: "left" | "right" | "up" | "down") => {
        if (!root || !resolvedActivePaneId) return;
        const target = findAdjacentLeaf(root, resolvedActivePaneId, direction);
        if (target) focusPane(target);
      },
      [root, resolvedActivePaneId, focusPane],
    );

    // One capture-phase listener per arrow direction so xterm doesn't swallow
    // the keys while its textarea is focused.
    useScopedGlobalShortcutById(
      "terminal-nav-pane-left",
      (e) => {
        e.preventDefault();
        navigatePane("left");
      },
      "terminal",
      { enabled: hotkeysEnabled },
    );
    useScopedGlobalShortcutById(
      "terminal-nav-pane-right",
      (e) => {
        e.preventDefault();
        navigatePane("right");
      },
      "terminal",
      { enabled: hotkeysEnabled },
    );
    useScopedGlobalShortcutById(
      "terminal-nav-pane-up",
      (e) => {
        e.preventDefault();
        navigatePane("up");
      },
      "terminal",
      { enabled: hotkeysEnabled },
    );
    useScopedGlobalShortcutById(
      "terminal-nav-pane-down",
      (e) => {
        e.preventDefault();
        navigatePane("down");
      },
      "terminal",
      { enabled: hotkeysEnabled },
    );

    useScopedGlobalShortcutById(
      "terminal-clear",
      (e) => {
        if (!resolvedActivePaneId) return;
        e.preventDefault();
        e.stopPropagation();
        paneRefs.current.get(resolvedActivePaneId)?.clearScreen();
      },
      "terminal",
      { enabled: hotkeysEnabled },
    );

    useScopedGlobalShortcutById(
      "terminal-delete-line",
      (e) => {
        if (!resolvedActivePaneId) return;
        e.preventDefault();
        e.stopPropagation();
        paneRefs.current.get(resolvedActivePaneId)?.clearInput();
      },
      "terminal",
      { enabled: hotkeysEnabled },
    );

    // Use ref for leaves so closePane stays stable
    const leavesRef = useRef(leaves);
    leavesRef.current = leaves;

    const closePane = useCallback(
      (paneId: string) => {
        paneRefs.current.get(paneId)?.markForKill();
        const currentLeaves = leavesRef.current;
        const idx = currentLeaves.findIndex((l) => l.id === paneId);
        const neighborIndex = idx > 0 ? idx - 1 : idx + 1;
        const neighbor = currentLeaves[neighborIndex];
        removePane(paneId);
        if (neighbor) {
          requestAnimationFrame(() => focusPane(neighbor.id));
        }
      },
      [removePane, focusPane],
    );

    const closeActivePane = useCallback(() => {
      if (resolvedActivePaneId) closePane(resolvedActivePaneId);
    }, [resolvedActivePaneId, closePane]);

    // CMD+W: kill the active split's PTY (via `closePane`, which marks the
    // pane for kill and removes the leaf). Scoped to the terminal tab.
    //
    // We only `preventDefault` + `stopPropagation` when there *is* a pane to
    // close — otherwise we let the event fall through to `useAppClose`'s
    // global meta+w (hooks/useAppClose.ts:108-115), which is the user-visible
    // "no terminals left, close the app" behaviour they asked for.
    //
    // Stopping propagation matters: without it, `useAppClose` would *also*
    // run after us and request a window close while the user only intended
    // to kill one split.
    useScopedGlobalShortcutById(
      "terminal-close",
      (e) => {
        if (!resolvedActivePaneId) return;
        e.preventDefault();
        e.stopPropagation();
        closePane(resolvedActivePaneId);
      },
      "terminal",
      { enabled: hotkeysEnabled },
    );

    const handlePaneExit = useCallback(
      (_ptyId: string, paneId: string) => {
        setTimeout(() => closePane(paneId), 500);
      },
      [closePane],
    );

    // Mark the old PTY for kill, then swap the leaf in-place so React
    // unmounts the stale XTermInstance and mounts a fresh one — which spawns
    // a new PTY at the feature's current expected cwd.
    const restartPane = useCallback(
      (paneId: string) => {
        paneRefs.current.get(paneId)?.markForKill();
        replaceLeafWithFresh(featureId, paneId);
      },
      [replaceLeafWithFresh, featureId],
    );

    const dismissPaneWarning = useCallback(
      (paneId: string) => dismissCwdWarning(featureId, paneId),
      [dismissCwdWarning, featureId],
    );

    const registerPlaceholder = useCallback((id: string, el: HTMLDivElement | null) => {
      if (el) placeholderRefs.current.set(id, el);
      else placeholderRefs.current.delete(id);
    }, []);

    // Move persistent slots into placeholders before paint
    useLayoutEffect(() => {
      for (const { leaf, slot } of activeSlots) {
        const placeholder = placeholderRefs.current.get(leaf.id);
        if (placeholder && slot.parentNode !== placeholder) {
          placeholder.appendChild(slot);
        }
      }
    }, [activeSlots]);

    return (
      <div
        className="relative flex h-full flex-col"
        data-focus-zone="terminal"
        tabIndex={0}
        onFocus={(e) => {
          if (e.target === e.currentTarget) focusFirstPane();
        }}
      >
        <TerminalPaneToolbar
          canClose={leaves.length > 0}
          onClose={closeActivePane}
          onSplit={splitAndFocus}
        />

        {/* Split tree layout — provides resizable placeholders */}
        <div
          className="min-h-0 flex-1 overflow-hidden transition-[height] duration-150 ease-in-out"
          style={isMinimized ? { height: 0, minHeight: 0 } : undefined}
        >
          {root && (
            <TerminalSplitTree
              node={root}
              expectedCwd={expectedCwd}
              onFocusPane={focusPane}
              onRestartPane={restartPane}
              onDismissWarning={dismissPaneWarning}
              onRegisterPlaceholder={registerPlaceholder}
            />
          )}
        </div>

        {/* Touch-keyboard accessory bar — restores Esc/Tab/Ctrl/arrows on phones */}
        {isMobile && leaves.length > 0 && !isMinimized && (
          <MobileTerminalKeyBar
            ctrlArmed={ctrlArmed}
            onToggleCtrl={toggleCtrl}
            onSendKey={sendKeyToActivePane}
          />
        )}

        {/* XTermInstances via portals into persistent slot elements — never unmount */}
        {activeSlots.map(({ leaf, slot }) =>
          createPortal(
            <XTermInstance
              key={leaf.id}
              ref={(handle) => setPaneRef(leaf.id, handle)}
              featureId={featureId}
              projectId={projectId}
              existingPtyId={leaf.ptyId}
              requestedCwd={expectedCwd ?? undefined}
              theme={xtermPalette}
              initialCommand={leaf.initialCommand}
              onInitialCommandConsumed={() => clearInitialCommand(featureId, leaf.id)}
              onPtyReady={(ptyId, cwd) => {
                setPtyId(featureId, leaf.id, ptyId);
                if (cwd) setPaneCwd(featureId, leaf.id, cwd);
              }}
              onExit={(ptyId) => handlePaneExit(ptyId, leaf.id)}
              onTerminalFocus={() => setActivePane(leaf.id)}
              ctrlArmed={ctrlArmed}
              onConsumeCtrl={consumeCtrl}
            />,
            slot,
            leaf.id,
          ),
        )}
      </div>
    );
  },
);
