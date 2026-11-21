import {
  memo,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
} from "react";
import { WebSocketSessionFeatureBlock } from "@/components/WebSocketSessionFeatureBlock";
import { ResolvedModelProvider } from "@/contexts/ResolvedModelContext";
import { useSaveLastOpenedFeature } from "@/hooks/useSaveLastOpenedFeature";
import { useMarkFeatureRead } from "@/stores/for-me-ack";
import {
  getFocusedTab,
  selectFeatureLayout,
  useFeatureLayoutStore,
} from "@/stores/feature-layout-store";
import {
  WorkspaceActivityProvider,
  createWorkspaceActivity,
  type WorkspaceActivity,
} from "./workspace-activity";
import {
  useApplyFocusRequest,
  useDismissLayersOnSwitch,
  useDropClosedWorkspaces,
  usePrewarmRequests,
  useTrimWhenIdle,
} from "./workspace-pool-hooks";
import {
  EMPTY_WORKSPACE_POOL,
  activateWorkspace,
  type WorkspacePoolState,
  type WorkspaceTarget,
} from "./workspace-pool-state";

interface SlotSize {
  width: number;
  height: number;
}

/**
 * Keeps recently opened conversation workspaces mounted and shows one.
 *
 * Opening a conversation used to unmount the previous workspace and mount a
 * new one: tens of milliseconds of teardown, then the whole mount (layout
 * shell, composer, transcript) before anything could paint. Here a workspace
 * that was shown before is only hidden, so going back to it flips two style
 * attributes and repaints. A conversation shown for the first time still
 * mounts, but next to the previous workspace instead of after its teardown,
 * and a sidebar press mounts it hidden before the click that shows it.
 *
 * Hidden workspaces stand down through `WorkspaceActivityProvider`; the least
 * recently shown ones beyond `WORKSPACE_POOL_LIMIT` are unmounted when the main
 * thread is idle, never during the switch. The tab a navigation asks for is
 * applied here on every activation (`useApplyFocusRequest`).
 */
export function WorkspacePool({ target }: { target: WorkspaceTarget }): ReactElement {
  const [state, setState] = useState<WorkspacePoolState>(() =>
    activateWorkspace(EMPTY_WORKSPACE_POOL, target),
  );
  // Derived from the route during render: the workspace to show must be in
  // this very commit, not one effect later.
  const pool = activateWorkspace(state, target);
  if (pool !== state) setState(pool);
  const activeId = target.sessionId;
  const rootRef = useRef<HTMLDivElement>(null);

  useTrimWhenIdle(pool, setState);
  useDropClosedWorkspaces(pool, activeId, setState);
  usePrewarmRequests(pool.prewarmed, setState);
  useDismissLayersOnSwitch(activeId, rootRef);
  useApplyFocusRequest(target);

  return (
    <div ref={rootRef} className="relative h-full">
      <ActiveConversationEffects projectId={target.projectId} featureId={target.featureId} />
      {pool.entries.map((entry) => (
        <WorkspaceSlot key={entry.sessionId} target={entry} active={entry.sessionId === activeId} />
      ))}
    </div>
  );
}

/** Effects that belong to "the conversation on screen", not to each mounted workspace. */
function ActiveConversationEffects({
  projectId,
  featureId,
}: {
  projectId: number;
  featureId: number;
}): null {
  // Opening a conversation reads it (unless For me clears only when done).
  useMarkFeatureRead(featureId);
  const focusedTabId = useFeatureLayoutStore(
    (s) => getFocusedTab(selectFeatureLayout(featureId)(s)) ?? "agent",
  );
  useSaveLastOpenedFeature(projectId, featureId, focusedTabId);
  return null;
}

const SLOT_CLASS = "absolute left-0 top-0";
const ACTIVE_STYLE: CSSProperties = { width: "100%", height: "100%" };

/**
 * A hidden slot keeps its layout (so the transcript stays measured and
 * scrolled where it was) but is neither painted nor reachable. `opacity`
 * backs `visibility` up: a descendant may set `visibility: visible`.
 *
 * It also leaves the viewport: split handles (`react-resizable-panels`) are
 * hit-tested by geometry from a document-level `pointerdown`, which `inert`,
 * `visibility` and `pointer-events` do not stop, so a hidden workspace stacked
 * on the visible one would catch presses near its handles. `left`, not a
 * transform: a transform would make the slot the containing block of its
 * fixed descendants, and changing it re-lays-out the whole subtree.
 */
function hiddenStyle(size: SlotSize | null): CSSProperties {
  return {
    left: "-200vw",
    visibility: "hidden",
    opacity: 0,
    pointerEvents: "none",
    // The box it had when it was hidden: a hidden workspace does not follow
    // window or sidebar resizes, it catches up when it is shown again.
    width: size ? size.width : "100%",
    height: size ? size.height : "100%",
  };
}

const WorkspaceSlot = memo(function WorkspaceSlot({
  target,
  active,
}: {
  target: WorkspaceTarget;
  active: boolean;
}): ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  const sizeRef = useRef<SlotSize | null>(null);
  const [activity] = useState(() => createWorkspaceActivity(active));
  // In the commit that flips the styles, before paint: the workspace shown
  // reads its live session and takes focus, the one hidden stops handling keys.
  useLayoutEffect(() => {
    activity.set(active);
  }, [active, activity]);
  // Tracked while visible so hiding never has to read layout in the switch's commit.
  useEffect(() => {
    const element = ref.current;
    if (!active || !element || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (box && box.width > 0 && box.height > 0) {
        sizeRef.current = { width: box.width, height: box.height };
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [active]);
  return (
    <div
      ref={ref}
      data-workspace-slot={active ? "active" : "hidden"}
      data-workspace-session={target.sessionId}
      className={SLOT_CLASS}
      style={active ? ACTIVE_STYLE : hiddenStyle(sizeRef.current)}
      inert={!active}
      aria-hidden={!active}
    >
      <WorkspaceContent target={target} activity={activity} />
    </div>
  );
});

/**
 * The workspace itself, behind its own memo boundary: showing or hiding a slot
 * changes the wrapper's style and nothing in here.
 */
const WorkspaceContent = memo(function WorkspaceContent({
  target,
  activity,
}: {
  target: WorkspaceTarget;
  activity: WorkspaceActivity;
}): ReactElement {
  return (
    <WorkspaceActivityProvider value={activity}>
      <ResolvedModelProvider featureId={target.featureId}>
        <WebSocketSessionFeatureBlock
          sessionId={target.sessionId}
          cwd={target.cwd}
          featureId={target.featureId}
          projectId={target.projectId}
          requestedFocusTab={target.focusTab}
        />
      </ResolvedModelProvider>
    </WorkspaceActivityProvider>
  );
});
