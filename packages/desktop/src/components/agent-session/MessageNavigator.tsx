import {
  memo,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
  type RefObject,
} from "react";
import type { VirtuosoHandle } from "react-virtuoso";
import type { DisplayItem } from "@/components/agentStreamDisplay";
import { markIndexAtFraction, type UserMessageMark } from "@/lib/agent-message-navigator";
import { cn } from "@/lib/utils";
import { MessageNavigatorPreview, type RailBox } from "./MessageNavigatorPreview";
import { useMessageNavigator, type MessageNavigatorControls } from "./useMessageNavigator";

/** Tick pitch while the rail has room; denser conversations compress to fit. */
const TICK_PITCH_PX = 14;
/**
 * The rail rests low, just above the composer: it grows upward from there,
 * oldest prompt on top, and never reaches into the composer's dissolve band.
 */
const RAIL_BOTTOM_PX = 44;
/** Space kept clear above the rail once it fills the stream's height. */
const RAIL_TOP_PX = 40;

interface MessageNavigatorProps {
  items: readonly DisplayItem[];
  virtuosoRef: RefObject<VirtuosoHandle | null>;
  scrollerRef: RefObject<HTMLElement | null>;
  controls: MessageNavigatorControls;
  shortcutsEnabled: boolean;
}

/** Vertical position of tick `index` along the rail, as a 0–1 fraction. */
function tickFraction(index: number, count: number): number {
  return (index + 0.5) / count;
}

/**
 * Dock-style magnification: the hovered tick stretches toward the transcript
 * and its neighbours follow at falling strength.
 */
function tickWidthPx(index: number, hovered: number | null, active: boolean): number {
  const rest = active ? 8 : 5;
  if (hovered === null) return rest;
  const strength = Math.max(0, 1 - Math.abs(index - hovered) / 3);
  return Math.max(rest, 5 + 7 * strength);
}

function railIndexFromPointer(
  event: ReactPointerEvent<HTMLElement> | ReactMouseEvent<HTMLElement>,
  count: number,
): number {
  const rect = event.currentTarget.getBoundingClientRect();
  return markIndexAtFraction((event.clientY - rect.top) / rect.height, count);
}

function tickLabel(mark: UserMessageMark, index: number, count: number): string {
  const preview = mark.text.length > 80 ? `${mark.text.slice(0, 80)}…` : mark.text;
  return `Jump to message ${index + 1} of ${count}${preview ? `: ${preview}` : ""}`;
}

interface TickProps {
  mark: UserMessageMark;
  index: number;
  count: number;
  isActive: boolean;
  isHovered: boolean;
  /** Its turn is loading so this prompt can be reached. */
  isPending: boolean;
  /** Passed resolved, so only the ticks the magnification reaches re-render. */
  width: number;
}

const Tick = memo(function Tick({
  mark,
  index,
  count,
  isActive,
  isHovered,
  isPending,
  width,
}: TickProps): ReactElement {
  const style: CSSProperties = {
    top: `${tickFraction(index, count) * 100}%`,
    width,
    // Thins out as the rail gets dense (`cqh` is the rail's own height), so
    // hundreds of prompts read as fine hairlines rather than a solid bar.
    height: `clamp(1px, calc(100cqh / ${count} * 0.35), 2px)`,
  };
  return (
    <button
      type="button"
      tabIndex={-1}
      aria-label={tickLabel(mark, index, count)}
      aria-current={isActive ? "location" : undefined}
      aria-busy={isPending || undefined}
      data-testid="message-navigator-tick"
      data-tick-index={index}
      style={style}
      className={cn(
        "absolute right-1 -translate-y-1/2 rounded-full",
        "transition-[width,background-color,box-shadow] duration-150 ease-[var(--ease-fluid)]",
        isActive
          ? "bg-primary shadow-[0_0_6px_color-mix(in_oklab,var(--primary)_55%,transparent)]"
          : "bg-muted-foreground/35",
        isHovered && !isActive && "bg-foreground/80",
        isPending && "animate-pulse bg-primary/70",
      )}
    />
  );
});

interface RailProps {
  marks: UserMessageMark[];
  activeIndex: number;
  pendingKey: string | null;
  onJump: (index: number) => void;
}

interface HoverState {
  index: number;
  /** Anchors the portaled preview. */
  rail: RailBox;
}

/** The rail's box and the top of the stream it sits in, in viewport coordinates. */
function measureRail(nav: HTMLElement): RailBox {
  const ceiling = nav.offsetParent?.getBoundingClientRect().top ?? 0;
  return { rect: nav.getBoundingClientRect(), ceiling };
}

// Memoized: the stream re-renders on every streaming delta, the rail's props don't change.
const MessageNavigatorRail = memo(function MessageNavigatorRail({
  marks,
  activeIndex,
  pendingKey,
  onJump,
}: RailProps): ReactElement {
  const [hover, setHover] = useState<HoverState | null>(null);
  const navRef = useRef<HTMLElement>(null);
  const [pendingRail, setPendingRail] = useState<RailBox | null>(null);
  // Measured once per pending jump: anchors the progress card.
  useLayoutEffect(() => {
    const nav = navRef.current;
    setPendingRail(pendingKey === null || !nav ? null : measureRail(nav));
  }, [pendingKey]);
  const hovered = hover?.index ?? null;
  const count = marks.length;
  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLElement>): void => {
      // Touch has no hover: a tap jumps straight away without a preview flash.
      if (event.pointerType === "touch") return;
      const index = railIndexFromPointer(event, count);
      // `currentTarget` is cleared once the handler returns: capture it here.
      const nav = event.currentTarget;
      setHover((previous) =>
        previous?.index === index ? previous : { index, rail: measureRail(nav) },
      );
    },
    [count],
  );
  const onRailClick = useCallback(
    (event: ReactMouseEvent<HTMLElement>): void => {
      // `detail === 0` is a keyboard / assistive-tech activation of a tick
      // button: there is no pointer position, so trust the button's own index.
      const tick =
        event.target instanceof HTMLElement
          ? event.target.closest<HTMLElement>("[data-tick-index]")
          : null;
      const index =
        event.detail === 0 && tick
          ? Number(tick.dataset.tickIndex)
          : railIndexFromPointer(event, count);
      onJump(index);
    },
    [count, onJump],
  );
  const railStyle: CSSProperties = {
    bottom: RAIL_BOTTOM_PX,
    height: `min(${count * TICK_PITCH_PX}px, calc(100% - ${RAIL_BOTTOM_PX + RAIL_TOP_PX}px))`,
  };
  const pendingIndex = pendingKey === null ? -1 : marks.findIndex((m) => m.key === pendingKey);
  // While history pages in, the target's card stays up as the progress
  // indicator; hovering another tick takes it over.
  const shown: HoverState | null =
    hover ?? (pendingIndex >= 0 && pendingRail ? { index: pendingIndex, rail: pendingRail } : null);
  const shownMark = shown ? marks[shown.index] : undefined;

  return (
    <nav
      ref={navRef}
      aria-label="Your messages"
      data-testid="message-navigator"
      // Lives in the lane AgentStream reserves right of the scroller, so it
      // never covers a message, the scrollbar or a split's resize handle.
      className="absolute right-0 z-10 w-4 translate-x-full cursor-pointer [container-type:size]"
      style={railStyle}
      onPointerMove={onPointerMove}
      onPointerLeave={() => setHover(null)}
      onClick={onRailClick}
    >
      {marks.map((mark, index) => (
        <Tick
          key={mark.key}
          mark={mark}
          index={index}
          count={count}
          isActive={index === activeIndex}
          isHovered={index === hovered}
          isPending={mark.key === pendingKey}
          width={tickWidthPx(index, hovered, index === activeIndex || mark.key === pendingKey)}
        />
      ))}
      {shownMark && shown && (
        <MessageNavigatorPreview
          mark={shownMark}
          index={shown.index}
          count={count}
          fraction={tickFraction(shown.index, count)}
          rail={shown.rail}
          loading={shownMark.key === pendingKey}
        />
      )}
    </nav>
  );
});

/**
 * Discreet map of the user's prompts along the agent stream's right edge.
 * Hover a tick to preview the message, click it to scroll there; ⌥↑ / ⌥↓ walk
 * the same list from the keyboard. Disabled from Settings → Appearance.
 */
export const MessageNavigator = memo(function MessageNavigator({
  items,
  virtuosoRef,
  scrollerRef,
  controls,
  shortcutsEnabled,
}: MessageNavigatorProps): ReactElement | null {
  const { marks, activeIndex, pendingKey, jumpTo } = useMessageNavigator({
    items,
    virtuosoRef,
    scrollerRef,
    controls,
    shortcutsEnabled,
  });
  // A rail with a single tick has nowhere to jump: it only reads as a stray
  // mark beside the transcript.
  if (marks.length < 2) return null;
  return (
    <MessageNavigatorRail
      marks={marks}
      activeIndex={activeIndex}
      pendingKey={pendingKey}
      onJump={jumpTo}
    />
  );
});
