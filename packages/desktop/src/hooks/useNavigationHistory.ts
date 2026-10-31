import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  useMatch,
  useNavigate,
  useRouterState,
  type UseNavigateResult,
} from "@tanstack/react-router";

import { useBrowserShortcutRelay } from "@/hooks/useBrowserShortcutRelay";
import { useGlobalShortcutById } from "@/hooks/useShortcut";
import { createNavigationHistory, type NavigationEntry } from "@/lib/navigation-history";
import { isInCodeMirrorEditor } from "@/lib/shortcuts/dom-targets";
import {
  activateFeatureTab,
  getFocusedTab,
  useFeatureLayoutStore,
} from "@/stores/feature-layout-store";

// A spot is recorded once it holds this long, so the in-between states of a
// conversation switch (deferred workspace mount, focused-tab handoff, index
// redirects) never land in the history.
const SETTLE_MS = 300;

/**
 * Slack-style ⌘[ / ⌘] history across conversations, their focused tab, and
 * the other pages. It observes where the user settles instead of
 * instrumenting every navigation call site.
 */
export function useNavigationHistory(): void {
  const navigate = useNavigate();
  const [history] = useState(createNavigationHistory);
  const entry = useCurrentEntry();
  const entryRef = useRef(entry);
  const settleTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  // The whole entry, not just its history key: a same-spot search change
  // (e.g. a new cwd) must refresh the recorded entry too.
  const signature = JSON.stringify(entry);

  // Sync after commit: a discarded render must never become the recorded spot.
  useLayoutEffect(() => {
    entryRef.current = entry;
  });
  useEffect(() => {
    history.arrive(entryRef.current);
    settleTimerRef.current = setTimeout(() => history.record(entryRef.current), SETTLE_MS);
    return () => clearTimeout(settleTimerRef.current);
  }, [history, signature]);

  const go = (delta: -1 | 1): void => {
    // `go` records the current spot itself; a pending settle would race the jump.
    clearTimeout(settleTimerRef.current);
    const target = history.go(delta, entryRef.current);
    if (target) restore(navigate, target, entryRef.current);
  };
  const onKey = (delta: -1 | 1) => (event: KeyboardEvent) => {
    // Inside a CodeMirror buffer ⌘[ / ⌘] stay indent less / more.
    if (isInCodeMirrorEditor(event.target)) return;
    event.preventDefault();
    go(delta);
  };
  useGlobalShortcutById("navigate-back", onKey(-1));
  useGlobalShortcutById("navigate-forward", onKey(1));
  useBrowserShortcutRelay((shortcut) => {
    if (shortcut === "navigate-back") go(-1);
    if (shortcut === "navigate-forward") go(1);
  });
}

function useCurrentEntry(): NavigationEntry {
  const href = useRouterState({ select: (state) => state.location.href });
  const session = useMatch({ from: "/ws-session/$sessionId", shouldThrow: false });
  const featureId = session?.search.featureId;
  const tab = useFeatureLayoutStore((state) => {
    const layout = featureId == null ? undefined : state.features[featureId];
    return layout ? getFocusedTab(layout) : null;
  });
  if (!session) return { kind: "page", href };
  const { cwd, projectId } = session.search;
  return {
    kind: "session",
    sessionId: session.params.sessionId,
    search: { cwd, featureId: session.search.featureId, projectId },
    tab,
  };
}

function restore(
  navigate: UseNavigateResult<string>,
  target: NavigationEntry,
  current: NavigationEntry,
): void {
  if (target.kind === "page") {
    void navigate({ href: target.href });
    return;
  }
  if (current.kind === "session" && current.sessionId === target.sessionId) {
    if (target.tab) activateFeatureTab(target.search.featureId, target.tab);
    return;
  }
  void navigate({
    to: "/ws-session/$sessionId",
    params: { sessionId: target.sessionId },
    search: target.tab ? { ...target.search, focusTab: target.tab } : target.search,
  });
}

/**
 * Mounts `useNavigationHistory` in a leaf of its own: it reads the focused tab,
 * which changes on every pane focus, and in the root layout's hooks that
 * re-rendered the whole app (sidebar, dialogs, workspace) each time.
 */
export function NavigationHistoryTracker(): null {
  useNavigationHistory();
  return null;
}
