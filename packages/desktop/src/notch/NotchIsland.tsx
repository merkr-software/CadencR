import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type {
  NotchAgent,
  NotchGeometry,
  NotchNotification,
  NotchPrimaryStyle,
  NotchSnoozeMinutes,
} from "@/shared/notch";
import { IndexDotsOrb } from "./IndexDotsOrb";
import { NotchActivityStrip } from "./NotchActivityStrip";
import { ambientAgents, compactDots } from "./notch-ambient";
import { notchBridge } from "./notch-bridge";
import {
  EAR_WIDTH,
  islandRadius,
  islandSize,
  isStripStyle,
  type IslandMode,
  type IslandSize,
} from "./notch-island-layout";
import { aggregateOrbState, NotchPanel, PanelEars } from "./NotchPanel";
import { NotchPeek, PeekEars, peekTone, type NotchTone } from "./NotchPeek";
import { useNotchFeed, type NotchFeed } from "./useNotchFeed";

/** Slack around the drawn shape the pointer may stray into before the island lets go. */
const HOT_SLACK = 10;

/**
 * Peek wins over the list unless the user was already browsing it; a peek the
 * pointer lands on is *held* (countdown paused, clickable) rather than swapped
 * for the list under the cursor.
 */
function useIslandMode(
  feed: NotchFeed,
  hasAmbient: boolean,
  statusHidden: boolean,
): { mode: IslandMode; held: boolean } {
  const { engaged, peek, prefs, snoozedUntil } = feed;
  // Only the moment of engagement decides between holding a peek and browsing.
  // Decided while rendering, so the panel never flashes in for a frame first.
  const [hold, setHold] = useState<{ engaged: boolean; peekId: string | null }>({
    engaged,
    peekId: null,
  });
  let holdPeekId = hold.peekId;
  if (hold.engaged !== engaged) {
    holdPeekId = engaged ? (peek?.id ?? null) : null;
    setHold({ engaged, peekId: holdPeekId });
  }

  const held = peek != null && holdPeekId === peek.id;
  if (peek && (statusHidden || !engaged || held)) return { mode: "peek", held };
  if (statusHidden) return { mode: "idle", held: false };
  if (engaged) return { mode: "expanded", held: false };
  // Out while something needs a glance; "always on" off or a snooze tucks it away between peeks.
  const ambient = prefs.alwaysOn && hasAmbient && snoozedUntil == null;
  return { mode: ambient ? "compact" : "idle", held: false };
}

/** Tell the main process where the pointer counts as "on the island" (in points). */
function useHotRect(
  size: IslandSize,
  viewportWidth: number,
  onError: (error: unknown) => void,
  slack: number,
): void {
  const { width, height } = size;
  useEffect(() => {
    notchBridge()
      .setHotRect({
        x: (viewportWidth - width) / 2 - slack,
        y: 0,
        width: width + slack * 2,
        height: height + slack,
      })
      .catch(onError);
  }, [height, width, viewportWidth, onError, slack]);
}

/** Aggregate orb (or the plain logo when still) + one dot per agent. */
function CompactEars({
  agents,
  still,
}: {
  agents: readonly NotchAgent[];
  still: boolean;
}): React.JSX.Element {
  const { shown, extra } = compactDots(agents);
  return (
    <>
      <span className="ear">
        <IndexDotsOrb state={still ? "logo" : aggregateOrbState(agents)} />
      </span>
      <span className="ear compact-dots" data-still={still} aria-label={`${agents.length} agents`}>
        {shown.map((agent, i) => (
          <span
            key={agent.featureId}
            className="compact-dot"
            data-status={agent.status}
            style={{ "--i": i } as CSSProperties}
          />
        ))}
        {extra > 0 ? <span className="compact-count">+{extra}</span> : null}
      </span>
    </>
  );
}

function compactEars(
  agents: readonly NotchAgent[],
  still: boolean,
  style: NotchPrimaryStyle,
  size: IslandSize,
): React.ReactNode {
  if (style === "none") return null;
  return isStripStyle(style) ? (
    <NotchActivityStrip agents={agents} still={still} width={size.width} height={size.height} />
  ) : (
    <CompactEars agents={agents} still={still} />
  );
}

function Layer({
  active,
  width,
  bandHeight,
  ears,
  children,
  flat = false,
}: {
  active: boolean;
  width: number;
  bandHeight: number;
  ears: React.ReactNode;
  children?: React.ReactNode;
  flat?: boolean;
}): React.JSX.Element {
  return (
    <div
      className="layer"
      data-active={active}
      data-flat={flat}
      style={{ width }}
      aria-hidden={!active}
    >
      <div className="ears" style={{ height: bandHeight }}>
        {ears}
      </div>
      {children}
    </div>
  );
}

/** Keep peek controls stable while the background agent feed updates. */
const PeekLayer = memo(function PeekLayer({
  active,
  notification,
  agent,
  width,
  bandHeight,
  paused,
  tone,
  error,
  onOpen,
  onDrop,
  onClose,
  onSnooze,
  onHeight,
}: {
  active: boolean;
  notification: NotchNotification | null;
  agent: NotchAgent | undefined;
  width: number;
  bandHeight: number;
  paused: boolean;
  tone: NotchTone;
  error: string | null;
  onOpen: (featureId: number | null, projectId: number | null) => void;
  onDrop: (id: string) => void;
  onClose: () => void;
  onSnooze: (minutes: NotchSnoozeMinutes | null) => void;
  onHeight: (height: number) => void;
}): React.JSX.Element {
  return (
    <Layer
      active={active}
      width={width}
      bandHeight={bandHeight}
      ears={notification ? <PeekEars notification={notification} tone={tone} /> : null}
    >
      {notification ? (
        <NotchPeek
          key={notification.id}
          notification={notification}
          agent={agent}
          paused={paused}
          tone={tone}
          error={error}
          onOpen={() => {
            onOpen(notification.featureId, notification.projectId);
            onDrop(notification.id);
          }}
          onExpire={() => onDrop(notification.id)}
          onClose={() => {
            onDrop(notification.id);
            onClose();
          }}
          onSnooze={onSnooze}
          onHeight={onHeight}
        />
      ) : null}
    </Layer>
  );
});

/** Opening and snoozing close the island in main; `settle` then skips the leave grace. */
function useIslandActions({ reportError, settle }: NotchFeed) {
  const open = useCallback(
    (featureId: number | null, projectId: number | null) => {
      if (featureId == null || projectId == null) return;
      notchBridge().openFeature({ featureId, projectId }).then(settle).catch(reportError);
    },
    [settle, reportError],
  );
  const openAgent = useCallback(
    (agent: NotchAgent) => open(agent.featureId, agent.projectId),
    [open],
  );
  const dismissAgent = useCallback(
    (agent: NotchAgent) => {
      notchBridge()
        .dismiss({ featureId: agent.featureId, projectId: agent.projectId })
        .catch(reportError);
    },
    [reportError],
  );

  const snooze = useCallback(
    (minutes: NotchSnoozeMinutes | null) => {
      notchBridge()
        .snooze(minutes)
        .then(() => {
          if (minutes != null) settle();
        })
        .catch(reportError);
    },
    [settle, reportError],
  );

  return { open, openAgent, dismissAgent, snooze };
}

/** The shape contracts on a quicker, overshoot-free curve than it grows on. */
function useShrinking(area: number): boolean {
  const previousArea = useRef(0);
  const shrinking = area < previousArea.current;
  useEffect(() => {
    previousArea.current = area;
  }, [area]);
  return shrinking;
}

export function NotchIsland(): React.JSX.Element | null {
  const feed = useNotchFeed();
  // Nothing to draw, and no hot rect to report, until main has placed the window.
  return feed.geometry ? <IslandView feed={feed} geometry={feed.geometry} /> : null;
}

function IslandView({
  feed,
  geometry,
}: {
  feed: NotchFeed;
  geometry: NotchGeometry;
}): React.JSX.Element {
  const { snapshot, peek, dropPeek, release, reportError } = feed;
  const ambient = useMemo(() => ambientAgents(snapshot.agents), [snapshot.agents]);
  const style = geometry.hardware ? "builtin" : feed.prefs.primaryStyle;
  const statusHidden = style === "none";
  const flatActivity = isStripStyle(style);
  const { mode, held } = useIslandMode(feed, ambient.length > 0, statusHidden);
  const [panelHeight, setPanelHeight] = useState(120);
  const [peekHeight, setPeekHeight] = useState(104);
  const bodies = { peek: peekHeight, panel: panelHeight };
  const { open, openAgent, dismissAgent, snooze } = useIslandActions(feed);
  // Ambient calm: the closed island only animates with "Always animate" on. Not gated on
  // the mode, so the compact layer keeps the logo while it fades out under a peek or panel.
  const still = !feed.prefs.alwaysAnimate;

  const lowProfile = flatActivity && (mode === "compact" || mode === "idle");
  const size = islandSize(mode, geometry, bodies, style);
  const compactSize = islandSize("compact", geometry, bodies, style);
  useHotRect(
    size,
    geometry.windowWidth,
    reportError,
    lowProfile || size.height === 0 ? 0 : HOT_SLACK,
  );
  const shrinking = useShrinking(size.width * size.height);

  const band = geometry.notchHeight;
  const peekAgent =
    peek?.featureId != null
      ? snapshot.agents.find((agent) => agent.featureId === peek.featureId)
      : undefined;
  const tone = peek ? peekTone(peek, peekAgent) : "done";

  return (
    <div
      className="island"
      data-mode={mode}
      data-hardware={geometry.hardware}
      data-flat={lowProfile}
      data-shrinking={shrinking}
      data-hidden={mode === "idle" && !geometry.hardware}
      style={
        {
          "--iw": `${size.width}px`,
          "--ih": `${size.height}px`,
          "--ir": `${islandRadius(mode, style)}px`,
          "--ear-w": `${EAR_WIDTH}px`,
          "--tone": `var(--n-${tone})`,
        } as CSSProperties
      }
    >
      <div className="island-glow" />
      <div className="island-body" />
      <span className="island-shoulder" data-side="left" />
      <span className="island-shoulder" data-side="right" />

      <Layer
        active={mode === "compact"}
        width={compactSize.width}
        bandHeight={compactSize.height}
        flat={flatActivity}
        ears={compactEars(ambient, still, style, compactSize)}
      />
      <PeekLayer
        active={mode === "peek"}
        notification={peek}
        agent={peekAgent}
        width={islandSize("peek", geometry, bodies, style).width}
        bandHeight={band}
        paused={held}
        tone={tone}
        error={feed.error}
        onOpen={open}
        onDrop={dropPeek}
        onClose={release}
        onSnooze={snooze}
        onHeight={setPeekHeight}
      />
      <Layer
        active={mode === "expanded"}
        width={islandSize("expanded", geometry, bodies, style).width}
        bandHeight={band}
        ears={<PanelEars agents={snapshot.agents} />}
      >
        <NotchPanel
          agents={snapshot.agents}
          active={mode === "expanded"}
          error={feed.error}
          onOpen={openAgent}
          onDismiss={dismissAgent}
          onHeight={setPanelHeight}
          snoozedUntil={feed.snoozedUntil}
          onSnooze={snooze}
        />
      </Layer>
    </div>
  );
}
