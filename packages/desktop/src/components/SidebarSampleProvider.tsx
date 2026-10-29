import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { SidebarAttentionContext } from "@/components/SidebarAttentionProvider";
import {
  buildSampleConversations,
  SAMPLE_ACTIVE_FEATURE_ID,
  SAMPLE_GATES,
  SAMPLE_NEWEST_REQUEST_FEATURE_ID,
  SAMPLE_PROJECT_COLORS,
  SAMPLE_PROJECT_ICONS,
  SAMPLE_SUMMARIES,
  SAMPLE_PROJECTS,
} from "@/lib/sidebar-sample-data";
import { sampleViews, type SampleRow, type SampleViews } from "@/lib/sidebar-sample-views";
import { SidebarSampleContext, type SidebarSampleData } from "@/lib/sidebar-sample-context";
import { useSidebarOption } from "@/stores/sidebar-config-store";
import { useSidebarSectionExpanded } from "@/hooks/useSidebarSections";
import { openSidebarGateOwner } from "@/stores/sidebar-surface-store";

interface SidebarSamplePreview {
  /** When the samples were made: their times count back from it. */
  now: number;
  rows: readonly SampleRow[];
  views: SampleViews;
  data: SidebarSampleData;
  activeFeatureId: number | null;
  select: (featureId: number) => void;
  /** Plays the samples' last changes again: rows flash, the newest request's popover opens. */
  replay: () => void;
  expandedProjects: ReadonlySet<number>;
  setProjectExpanded: (projectId: number, expanded: boolean) => void;
  collapsedParents: ReadonlySet<number>;
  setParentCollapsed: (featureId: number, collapsed: boolean) => void;
}

/** Long enough for the "before" states to paint before the samples reach theirs. */
const REPLAY_DELAY_MS = 600;
const NONE: ReadonlySet<number> = new Set();

const SidebarSamplePreviewContext = createContext<SidebarSamplePreview | null>(null);

/** The preview's state, or null when the real conversations show. */
export function useSidebarSamplePreview(): SidebarSamplePreview | null {
  return useContext(SidebarSamplePreviewContext);
}

/** The preview's state, for the sample parts rendered under {@link SampleScope}. */
export function useSamplePreview(): SidebarSamplePreview {
  const preview = useContext(SidebarSamplePreviewContext);
  if (!preview) throw new Error("Sample parts render under a SampleScope");
  return preview;
}

/**
 * Holds the display options preview's sample workspace: which sample is open
 * or answered, and the replay. Always mounted where it is used, so switching
 * between samples and real conversations keeps everything under it mounted
 * (the display options popover lives there); `enabled` only decides whether
 * the preview shows, and each time it starts showing the samples start over.
 */
export function SidebarSampleProvider({
  enabled,
  children,
}: {
  enabled: boolean;
  children: ReactNode;
}): ReactElement {
  const preview = useSampleState(enabled);
  return (
    <SidebarSamplePreviewContext.Provider value={enabled ? preview : null}>
      {children}
    </SidebarSamplePreviewContext.Provider>
  );
}

/**
 * Renders `children` only while the preview shows, feeding the shared row
 * components and the attention readers (badges, rail) the samples.
 */
export function SampleScope({ children }: { children: ReactNode }): ReactElement | null {
  const preview = useSidebarSamplePreview();
  if (!preview) return null;
  return (
    <SidebarSampleContext.Provider value={preview.data}>
      <SidebarAttentionContext.Provider value={preview.views.attention}>
        {children}
      </SidebarAttentionContext.Provider>
    </SidebarSampleContext.Provider>
  );
}

function useSampleState(enabled: boolean): SidebarSamplePreview {
  const [now, setNow] = useState(Date.now);
  const conversations = useMemo(() => buildSampleConversations(now), [now]);
  const [activeFeatureId, setActiveFeatureId] = useState<number | null>(SAMPLE_ACTIVE_FEATURE_ID);
  const [answered, setAnswered] = useState<ReadonlySet<number>>(NONE);
  const resetAnswered = useCallback(() => setAnswered(NONE), []);
  const { replaying, replays, replay, resetReplay } = useReplay(resetAnswered);
  const expanded = useIdSet(() => SAMPLE_PROJECTS.filter((p) => !p.collapsed).map((p) => p.id));
  const collapsedParents = useIdSet(() => []);
  const forMe = useSidebarOption("forMe");
  const recentCount = Number(useSidebarOption("recentCount"));
  const forMeExpanded = useSidebarSectionExpanded("for-me");

  // Each showing starts from fresh samples, timed from now, before it paints.
  useLayoutEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    setActiveFeatureId(SAMPLE_ACTIVE_FEATURE_ID);
    resetAnswered();
    resetReplay();
  }, [enabled, resetAnswered, resetReplay]);

  const rows = useMemo(
    () =>
      conversations.map((conversation): SampleRow => ({
        conversation,
        state: answered.has(conversation.feature.id)
          ? "working"
          : replaying
            ? conversation.before
            : conversation.state,
      })),
    [answered, conversations, replaying],
  );
  const views = useMemo(() => sampleViews(rows, recentCount), [recentCount, rows]);
  const respond = useCallback(
    (featureId: number) => setAnswered((prior) => new Set(prior).add(featureId)),
    [],
  );
  const gateOwner = openSidebarGateOwner(forMe && forMeExpanded, false);
  const data = useMemo<SidebarSampleData>(
    () => ({
      projectColors: SAMPLE_PROJECT_COLORS,
      projectIcons: SAMPLE_PROJECT_ICONS,
      gates: SAMPLE_GATES,
      summaries: SAMPLE_SUMMARIES,
      mostRecentPendingFeatureId: replays > 0 ? SAMPLE_NEWEST_REQUEST_FEATURE_ID : null,
      pendingRequestId: replays > 0 ? `sample-replay-${replays}` : null,
      gateOwner,
      respond,
    }),
    [gateOwner, replays, respond],
  );

  return useMemo(
    () => ({
      now,
      rows,
      views,
      data,
      activeFeatureId,
      select: setActiveFeatureId,
      replay,
      expandedProjects: expanded.ids,
      setProjectExpanded: expanded.set,
      collapsedParents: collapsedParents.ids,
      setParentCollapsed: collapsedParents.set,
    }),
    [activeFeatureId, collapsedParents, data, expanded, now, replay, rows, views],
  );
}

/**
 * A replay sets every sample back to where it came from, then lets it reach
 * its state again: the same transitions a live conversation goes through.
 */
function useReplay(onStart: () => void): {
  replaying: boolean;
  replays: number;
  replay: () => void;
  resetReplay: () => void;
} {
  const [replaying, setReplaying] = useState(false);
  const [replays, setReplays] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const replay = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    onStart();
    setReplaying(true);
    timer.current = setTimeout(() => {
      timer.current = null;
      setReplaying(false);
      setReplays((count) => count + 1);
    }, REPLAY_DELAY_MS);
  }, [onStart]);
  const resetReplay = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setReplaying(false);
    setReplays(0);
  }, []);
  return { replaying, replays, replay, resetReplay };
}

function useIdSet(initial: () => readonly number[]): {
  ids: ReadonlySet<number>;
  set: (id: number, member: boolean) => void;
} {
  const [ids, setIds] = useState<ReadonlySet<number>>(() => new Set(initial()));
  const set = useCallback((id: number, member: boolean) => {
    setIds((prior) => {
      if (prior.has(id) === member) return prior;
      const next = new Set(prior);
      if (member) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);
  return useMemo(() => ({ ids, set }), [ids, set]);
}
