import { recordDiagnosticEvent } from "@/lib/renderer-diagnostics";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { FollowOutput, VirtuosoHandle } from "react-virtuoso";
import type { AgentBlockData } from "@/types/agent-block";
import { isAutoScrollPinSuppressed } from "@/lib/agent-scroll-suppression";
import { isIos } from "@/lib/is-ios";
import { subscribeResize } from "@/lib/resize-coordinator";
import { type StartJump, type UseAgentSessionScrollResult } from "./agent-session-scroll-utils";
import { ScrollAnchorGuard } from "./stream-scroll-anchor";
import { StreamScrollWriter } from "./stream-scroll-writer";
import type { HistoryGap } from "@/types/agent-stream";
import { NO_HISTORY_GAPS } from "@/stores/ws-history-gaps";
import { useAgentSessionScrollInput } from "./useAgentSessionScrollInput";
import { type FillHistoryGap, useHistoryGapFiller } from "./useHistoryGapFiller";

interface UseAgentSessionScrollOptions {
  blocks: AgentBlockData[];
  conversationKey: string | null;
  /** Saved history not loaded yet; each gap's row fills as it nears the view. */
  historyGaps?: HistoryGap[];
  onFillGap?: FillHistoryGap;
}

function useScrollState(options: UseAgentSessionScrollOptions) {
  const virtuosoRef = useRef<VirtuosoHandle | null>(null);
  const scrollerElRef = useRef<HTMLElement | null>(null);
  const stickRef = useRef(true);
  const lastScrollTopRef = useRef(0);
  const suppressScrollIntentRef = useRef(false);
  const userScrollIntentRef = useRef(false);
  const prevConversationKeyRef = useRef<string | null>(options.conversationKey);
  const didFirstPaintScrollRef = useRef(false);
  const [autoScrollEnabled, setAutoScrollEnabledState] = useState(true);
  return useMemo(
    () => ({
      autoScrollEnabled,
      didFirstPaintScrollRef,
      lastScrollTopRef,
      prevConversationKeyRef,
      scrollerElRef,
      setAutoScrollEnabledState,
      stickRef,
      suppressScrollIntentRef,
      userScrollIntentRef,
      virtuosoRef,
    }),
    [autoScrollEnabled],
  );
}

export type ScrollState = ReturnType<typeof useScrollState>;

function useScrollPinning(state: ScrollState, writer: StreamScrollWriter) {
  const setAutoScrollEnabled = useCallback(
    (enabled: boolean): void => {
      if (state.stickRef.current === enabled) return;
      recordDiagnosticEvent("scroll", { following: enabled });
      state.stickRef.current = enabled;
      // Synchronously, before the scroll this input causes reaches the anchor
      // guard: a glide in flight must be scroll offset by then, not transform.
      if (!enabled) writer.releaseFollow();
      state.setAutoScrollEnabledState(enabled);
    },
    [state.setAutoScrollEnabledState, state.stickRef, writer],
  );
  // The writer skips the raw pin on iOS, where Virtuoso owns bottom pinning
  // through its deviation-aware `followOutput` path, and once stick lets go.
  const pinScrollerToEnd = useCallback((): void => {
    writer.pinToBottom();
  }, [writer]);
  const followBottom = useCallback((): void => {
    writer.followBottom();
  }, [writer]);
  // The scroller outlives a conversation switch (the session view is not
  // keyed by conversation): its rows must not inherit the old glide.
  const stopFollowGlide = useCallback((): void => {
    writer.stopFollowGlide();
  }, [writer]);
  const pinToEnd = useCallback((): void => {
    // The raw pin lands on the real bottom. An index scroll is aimed from
    // Virtuoso's size table and lands short wherever that table drifts from
    // the DOM, so it only stands in where no raw write may happen: iOS, or a
    // scroller not attached yet. The follow-up frame catches rows Virtuoso is
    // still sizing.
    if (writer.canWrite("follow-bottom")) {
      writer.pinToBottom();
    } else {
      writer.scrollToIndex(state.virtuosoRef.current, "follow-bottom", {
        index: "LAST",
        align: "end",
        behavior: "auto",
      });
    }
    requestAnimationFrame(pinScrollerToEnd);
  }, [pinScrollerToEnd, state.virtuosoRef, writer]);
  // Forget a scroll-up in progress: the next one must start from here.
  const resetIntent = useCallback((): void => {
    state.userScrollIntentRef.current = false;
    state.lastScrollTopRef.current = state.scrollerElRef.current?.scrollTop ?? 0;
  }, [state.lastScrollTopRef, state.scrollerElRef, state.userScrollIntentRef]);
  const suppressProgrammaticScrollIntent = useCallback((): void => {
    state.suppressScrollIntentRef.current = true;
    requestAnimationFrame(() => {
      state.lastScrollTopRef.current =
        state.scrollerElRef.current?.scrollTop ?? state.lastScrollTopRef.current;
      state.suppressScrollIntentRef.current = false;
    });
  }, [state.lastScrollTopRef, state.scrollerElRef, state.suppressScrollIntentRef]);
  return useMemo(
    () => ({
      followBottom,
      pinToEnd,
      resetIntent,
      setAutoScrollEnabled,
      stopFollowGlide,
      suppressProgrammaticScrollIntent,
    }),
    [
      followBottom,
      pinToEnd,
      resetIntent,
      setAutoScrollEnabled,
      stopFollowGlide,
      suppressProgrammaticScrollIntent,
    ],
  );
}

type ScrollPinning = ReturnType<typeof useScrollPinning>;

function useScrollCallbacks(state: ScrollState, pinning: ScrollPinning) {
  const scrollToBottom = useCallback((): void => {
    pinning.resetIntent();
    pinning.setAutoScrollEnabled(true);
    pinning.pinToEnd();
  }, [pinning]);
  const followOutput = useMemo<FollowOutput>(
    () =>
      // Off iOS, Virtuoso does not follow at all: the growth observer, the
      // viewport observer and `onTotalListHeightChanged` pin the real bottom.
      // Virtuoso's follow is an index scroll aimed from its size table: when
      // that drifts from the DOM (a row margin it never measured did 7–15 px)
      // it lands short as a row is added, retries for 150 ms, and stays short
      // until the next growth. It must be `false`, not a callback returning false:
      // given any callback, Virtuoso also follows on size increase and on
      // viewport shrink without consulting it.
      isIos()
        ? () => (state.stickRef.current && !isAutoScrollPinSuppressed() ? "auto" : false)
        : false,
    [state.stickRef],
  );
  const onAtBottomStateChange = useCallback(
    (atBottom: boolean): void => {
      if (!atBottom) return;
      const wasDisengaged = !state.stickRef.current;
      pinning.resetIntent();
      pinning.setAutoScrollEnabled(true);
      if (wasDisengaged) pinning.pinToEnd();
    },
    [pinning, state.stickRef],
  );
  const onTotalListHeightChanged = useCallback(
    (_height: number): void => {
      // Skip the bottom-pin while a recap toggle is animating its height — that
      // height delta is user-driven, not new content, so re-pinning would jump
      // the clicked recap out of view.
      if (!state.stickRef.current || isAutoScrollPinSuppressed()) return;
      // A raw pin to the real bottom, not `scrollToIndex`: Virtuoso aims the
      // index scroll from its size table, and any drift from the DOM lands it
      // a few px short of the bottom the growth observer already pinned. Each
      // streamed line then painted one frame dipped down (timer included)
      // before the follow-up pin snapped it back: the double jump. The raw pin
      // is idempotent, so once the growth observer has pinned, this is a
      // no-op. On iOS, reissuing scrollToIndex from Virtuoso's own height
      // callback closes a feedback loop, and `followOutput` already owns that
      // platform's streaming bottom pin.
      if (!isIos()) pinning.followBottom();
    },
    [pinning, state.stickRef],
  );
  return useMemo(
    () => ({ followOutput, onAtBottomStateChange, onTotalListHeightChanged, scrollToBottom }),
    [followOutput, onAtBottomStateChange, onTotalListHeightChanged, scrollToBottom],
  );
}

function useScrollLifecycle(
  state: ScrollState,
  pinning: ScrollPinning,
  conversationKey: string | null,
  blocksLength: number,
) {
  useLayoutEffect(() => {
    if (state.prevConversationKeyRef.current === conversationKey) return;
    recordDiagnosticEvent("scroll", { event: "conversation-changed", following: true });
    state.prevConversationKeyRef.current = conversationKey;
    state.stickRef.current = true;
    pinning.resetIntent();
    state.setAutoScrollEnabledState(true);
    state.didFirstPaintScrollRef.current = false;
    pinning.suppressProgrammaticScrollIntent();
    pinning.stopFollowGlide();
    pinning.pinToEnd();
  }, [conversationKey, pinning, state]);
  useEffect(() => {
    if (state.didFirstPaintScrollRef.current || blocksLength === 0) return;
    state.didFirstPaintScrollRef.current = true;
    if (state.stickRef.current) pinning.pinToEnd();
  }, [blocksLength, pinning, state.didFirstPaintScrollRef, state.stickRef]);
  useEffect(
    () =>
      subscribeResize((active) => {
        if (!active && state.stickRef.current) pinning.pinToEnd();
      }),
    [pinning, state.stickRef],
  );
}

/**
 * One programmatic jump at a time, whoever starts it (the prompt rail, the
 * composer's agent list): a new one cancels the one still settling, so two
 * never fight over `scrollTop`. Identity-stable, unlike `prepareJump`.
 */
export function useJumpOwner(prepareJump: () => () => void): StartJump {
  const prepareRef = useRef(prepareJump);
  prepareRef.current = prepareJump;
  const cancelRef = useRef<(() => void) | null>(null);
  useEffect(() => () => cancelRef.current?.(), []);
  return useCallback((run) => {
    // Prepared before the old jump is cancelled: the old one's release, which
    // its cancel triggers, then no longer ends the new jump's hold.
    const settled = prepareRef.current();
    cancelRef.current?.();
    const cancel = run(settled);
    cancelRef.current = cancel;
    return cancel;
  }, []);
}

export function useAgentSessionScroll(
  options: UseAgentSessionScrollOptions,
): UseAgentSessionScrollResult {
  const state = useScrollState(options);
  // Every scroll write names its intent through this writer; a jump or reveal
  // it performs releases bottom-stick through `prepareJump` (set below).
  const prepareJumpRef = useRef<() => () => void>(() => () => {});
  const [writer] = useState(
    () =>
      new StreamScrollWriter({
        isFollowing: () => state.stickRef.current,
        // A write the writer moves on its own (a reveal) holds until input.
        prepareJump: () => {
          prepareJumpRef.current();
        },
      }),
  );
  const pinning = useScrollPinning(state, writer);
  const [anchorGuard] = useState(() => new ScrollAnchorGuard(() => state.stickRef.current));
  const gaps = useHistoryGapFiller({
    scrollerElRef: state.scrollerElRef,
    conversationKey: options.conversationKey,
    historyGaps: options.historyGaps ?? NO_HISTORY_GAPS,
    onFillGap: options.onFillGap,
    delayBeforeFill: () => writer.indexScrollSettlesIn(),
    isFollowing: () => state.stickRef.current,
  });
  const callbacks = useScrollCallbacks(state, pinning);
  const { resetIntent, setAutoScrollEnabled } = pinning;
  const { holdForJump } = gaps;
  // A programmatic jump owns the viewport: bottom-stick lets go, and neither
  // the anchor guard nor a history page landing above it may pull it away
  // until the jump settles (the returned release) or the reader takes over.
  const prepareJump = useCallback((): (() => void) => {
    const releaseGuard = anchorGuard.suspend();
    const releaseGaps = holdForJump();
    resetIntent();
    setAutoScrollEnabled(false);
    return () => {
      releaseGuard();
      releaseGaps();
    };
  }, [anchorGuard, holdForJump, resetIntent, setAutoScrollEnabled]);
  prepareJumpRef.current = prepareJump;
  const startJump = useJumpOwner(prepareJump);
  useScrollLifecycle(state, pinning, options.conversationKey, options.blocks.length);
  const scrollContainerRef = useAgentSessionScrollInput({
    scrollerElRef: state.scrollerElRef,
    stickRef: state.stickRef,
    writer,
    anchorGuard,
    lastScrollTopRef: state.lastScrollTopRef,
    userScrollIntentRef: state.userScrollIntentRef,
    suppressScrollIntentRef: state.suppressScrollIntentRef,
    setAutoScrollEnabled: pinning.setAutoScrollEnabled,
    onScrollActivity: gaps.schedule,
    onUserInput: gaps.resumeFromInput,
  });
  return useMemo(
    () => ({
      virtuosoRef: state.virtuosoRef,
      scrollContainerRef,
      itemSize: anchorGuard.measureItem,
      followOutput: callbacks.followOutput,
      onAtBottomStateChange: callbacks.onAtBottomStateChange,
      onTotalListHeightChanged: callbacks.onTotalListHeightChanged,
      autoScrollEnabled: state.autoScrollEnabled,
      historyGapStatus: gaps.status,
      holdHistoryFills: gaps.holdForJump,
      scrollToBottom: callbacks.scrollToBottom,
      startJump,
    }),
    [
      anchorGuard,
      callbacks,
      gaps.holdForJump,
      gaps.status,
      scrollContainerRef,
      startJump,
      state.autoScrollEnabled,
      state.virtuosoRef,
    ],
  );
}
