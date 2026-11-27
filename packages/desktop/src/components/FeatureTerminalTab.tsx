import {
  memo,
  useRef,
  useEffect,
  forwardRef,
  useImperativeHandle,
  useCallback,
  useMemo,
} from "react";
import { TerminalPanel, type TerminalPanelHandle } from "@/components/terminal/TerminalPanel";
import { useTerminalState, useTerminalStore } from "@/hooks/useTerminalState";
import { useScopedGlobalShortcutById } from "@/hooks/useShortcut";
import { useListProjects } from "@/api/generated";
import { fetchTerminalSessions } from "@/api/terminal-sessions";
import { useFeatureWorktreePath } from "@/hooks/useFeatureWorktreePath";
import { getCoarsePointerSnapshot } from "@/lib/form-factor";
import {
  getFocusedTab,
  isTabVisible,
  selectFeatureLayout,
  useFeatureLayoutStore,
} from "@/stores/feature-layout-store";

interface FeatureTerminalTabProps {
  featureId: number;
  projectId: number;
  hidden?: boolean;
  activeOverride?: boolean;
  focusedOverride?: boolean;
  hotkeysEnabled?: boolean;
}

export interface FeatureTerminalTabHandle {
  /** Ensure a terminal pane exists and focus it (under a finger: open it, never focus) */
  activate: () => void;
}

function useEnsureTerminalOpen(featureId: number): () => Promise<void> {
  // Guards the one-shot async hydration so StrictMode's double-invoke
  // (and overlapping visibility/focus effects) can't fire two backend
  // lookups — and thus two pane trees — for the same empty feature.
  const hydratingRef = useRef(false);

  return useCallback(async (): Promise<void> => {
    const store = useTerminalStore.getState();
    if (!store.getFeature(featureId).root) {
      // A hydration is already resolving the tree; it will also open the
      // panel, so bail rather than racing it with a fresh `togglePanel`.
      if (hydratingRef.current) return;
      hydratingRef.current = true;
      try {
        const sessions = await fetchTerminalSessions(featureId).catch((err: unknown) => {
          // Degrade to a fresh shell — the terminal still opens, we just
          // don't auto-attach this time. (Not a user-facing failure.)
          console.warn("[terminal] could not list existing sessions; spawning fresh", err);
          return [];
        });
        if (!store.getFeature(featureId).root) {
          if (sessions.length > 0) {
            store.adoptPtys(
              featureId,
              sessions.map((session) => ({ ptyId: session.pty_id, cwd: session.cwd })),
            );
          } else {
            store.addPane(featureId);
          }
        }
      } finally {
        hydratingRef.current = false;
      }
    }
    if (!store.getFeature(featureId).isOpen) {
      store.togglePanel(featureId);
    }
  }, [featureId]);
}

export const FeatureTerminalTab = memo(
  forwardRef<FeatureTerminalTabHandle, FeatureTerminalTabProps>(function FeatureTerminalTab(
    { featureId, projectId, hidden, activeOverride, focusedOverride, hotkeysEnabled = true },
    ref,
  ) {
    const terminalRef = useRef<TerminalPanelHandle>(null);
    const terminalState = useTerminalState(featureId);
    const layoutTerminalVisible = useFeatureLayoutStore((s) =>
      isTabVisible(selectFeatureLayout(featureId)(s), "terminal"),
    );
    const layoutTerminalFocused = useFeatureLayoutStore(
      (s) => getFocusedTab(selectFeatureLayout(featureId)(s)) === "terminal",
    );
    const isTerminalVisible = activeOverride ?? layoutTerminalVisible;
    const isTerminalFocused = focusedOverride ?? layoutTerminalFocused;

    // Compute the cwd a freshly-spawned terminal *would* end up in, given the
    // current feature settings: the worktree if one was created, otherwise the
    // project root.
    const worktreePath = useFeatureWorktreePath(featureId, projectId);
    const projectsQuery = useListProjects();
    const projectPath = useMemo(
      () => projectsQuery.data?.find((p) => p.id === projectId)?.path ?? null,
      [projectsQuery.data, projectId],
    );
    const expectedCwd = worktreePath === undefined ? null : (worktreePath ?? projectPath);

    // Open the terminal, attaching to the feature's already-running shells when
    // any exist so a second device (e.g. a remote browser) mirrors and can type
    // into the same session instead of spawning a fresh one. Reads fresh store
    // state throughout (never a captured closure) so it stays idempotent under
    // StrictMode: a stale `panes.length === 0` would otherwise `addPane()` twice
    // and split into a phantom 2-pane terminal.
    const ensureTerminalOpen = useEnsureTerminalOpen(featureId);

    const activate = useCallback(async (): Promise<void> => {
      await ensureTerminalOpen();
      // Under a finger, focusing raises the on-screen keyboard, which pans the
      // page and hides the header: a tap into the terminal focuses it (the
      // pane's click), and the key bar writes without focus. A narrow window
      // with a mouse (the phone layout in Electron) still focuses. Read at
      // call time: the primary pointer can change while it stays mounted.
      if (getCoarsePointerSnapshot()) return;
      requestAnimationFrame(() => terminalRef.current?.focusActivePane());
    }, [ensureTerminalOpen]);

    useImperativeHandle(ref, () => ({ activate }), [activate]);

    // CMD+T (scoped to the terminal tab): focus the first pane if any exist,
    // otherwise open a fresh terminal. Read fresh state via `getState()` so
    // the callback doesn't go stale when panes are added/removed without a
    // re-render of this component.
    useScopedGlobalShortcutById(
      "terminal-focus",
      (e) => {
        if (hidden) return;
        e.preventDefault();
        const fresh = useTerminalStore.getState().getFeature(featureId);
        if (fresh.root) {
          terminalRef.current?.focusFirstPane();
        } else {
          void activate();
        }
      },
      "terminal",
      { enabled: hotkeysEnabled && !hidden },
    );

    // Track whether any pane exists. Closing the last pane (Cmd+W or the X
    // button) sets `root` to null. Including this flag in the effects below
    // makes them re-run the instant the pane count drops to zero — without it,
    // the auto-open effect only fires when `isTerminalVisible` *changes*, so
    // killing the only terminal left a blank panel until the user switched
    // tabs and back. Reacting to `hasPanes` restarts a fresh terminal in place.
    const hasPanes = terminalState.root != null;

    // Auto-create a pane and open if none exist when the terminal tab is visible,
    // but only move real DOM focus there when this pane is the focused one.
    useEffect(() => {
      if (hidden || !isTerminalVisible) return;
      void ensureTerminalOpen();
    }, [hidden, ensureTerminalOpen, isTerminalVisible, hasPanes]);

    useEffect(() => {
      if (hidden || !isTerminalFocused) return;
      void activate();
    }, [hidden, activate, isTerminalFocused, hasPanes]);

    return (
      <div className={hidden ? "hidden" : "h-full"}>
        <TerminalPanel
          ref={terminalRef}
          featureId={featureId}
          projectId={projectId}
          state={terminalState}
          splitPane={terminalState.splitPane}
          removePane={terminalState.removePane}
          expectedCwd={expectedCwd}
          hotkeysEnabled={hotkeysEnabled}
        />
      </div>
    );
  }),
);
