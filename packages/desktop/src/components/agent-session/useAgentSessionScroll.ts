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
import { useAgentSessionScrollInput } from "./useAgentSessionScrollInput";
import { type HistoryLoader, useHistoryLoader } from "./useOlderHistoryLoader";

interface UseAgentSessionScrollOptions {
  blocks: AgentBlockData[];
  conversationKey: string | null;
  hasMore?: boolean;
  onLoadOlder?: () => Promise<number | void>;
}

function useScrollState(options: UseAgentSessionScrollOptions) {
  const virtuosoRef = useRef<VirtuosoHandle | null>(null);
  const scrollerElRef = useRef<HTMLElement | null>(null);
  const stickRef = useRef(true);
  const historyLoadArmedRef = useRef(false);
  const loadingOlderRef = useRef(false);
  const loadGenerationRef = useRef(0);
  const lastScrollTopRef = useRef(0);
  const suppressScrollIntentRef = useRef(false);
  const userScrollIntentRef = useRef(false);
  const prevConversationKeyRef = useRef<string | null>(options.conversationKey);
  const didFirstPaintScrollRef = useRef(false);
  const viewportFillPagesRef = useRef(0);
  const [autoScrollEnabled, setAutoScrollEnabledState] = useState(true);
  const [isLoadingOlder, setIsLoadingOlder] = useState(false);
  const [olderLoadError, setOlderLoadError] = useState<string | null>(null);
  const hasMoreRef = useRef(options.hasMore);
  const onLoadOlderRef = useRef(options.onLoadOlder);
  hasMoreRef.current = options.hasMore;
  onLoadOlderRef.current = options.onLoadOlder;
  return useMemo(
    () => ({
      autoScrollEnabled,
      didFirstPaintScrollRef,
      hasMoreRef,
      historyLoadArmedRef,
      isLoadingOlder,
      lastScrollTopRef,
      loadGenerationRef,
      loadingOlderRef,
      olderLoadError,
      onLoadOlderRef,
      prevConversationKeyRef,
      scrollerElRef,
      setAutoScrollEnabledState,
      setIsLoadingOlder,
      setOlderLoadError,
      stickRef,
      suppressScrollIntentRef,
      userScrollIntentRef,
      viewportFillPagesRef,
      virtuosoRef,
    }),
    [autoScrollEnabled, isLoadingOlder, olderLoadError],
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
      setAutoScrollEnabled,
      stopFollowGlide,
      suppressProgrammaticScrollIntent,
    }),
    [
      followBottom,
      pinToEnd,
      setAutoScrollEnabled,
      stopFollowGlide,
      suppressProgrammaticScrollIntent,
    ],
  );
}

type ScrollPinning = ReturnType<typeof useScrollPinning>;

function useScrollCallbacks(state: ScrollState, pinning: ScrollPinning, history: HistoryLoader) {
  const scrollToBottom = useCallback((): void => {
    history.resetIntent();
    pinning.setAutoScrollEnabled(true);
    pinning.pinToEnd();
  }, [history, pinning]);
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
      history.resetIntent();
      pinning.setAutoScrollEnabled(true);
      if (wasDisengaged) pinning.pinToEnd();
    },
    [history, pinning, state.stickRef],
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
      // platform's streaming bottom pin; viewport backfill remains independent
      // below.
      if (!isIos()) pinning.followBottom();
      history.maybeFillViewport();
    },
    [history, pinning, state.stickRef],
  );
  const onStartReached = useCallback((): void => {
    if (state.historyLoadArmedRef.current) history.requestOlderHistory();
  }, [history, state.historyLoadArmedRef]);
  return useMemo(
    () => ({
      followOutput,
      onAtBottomStateChange,
      onStartReached,
      onTotalListHeightChanged,
      scrollToBottom,
    }),
    [followOutput, onAtBottomStateChange, onStartReached, onTotalListHeightChanged, scrollToBottom],
  );
}

function useScrollLifecycle(
  state: ScrollState,
  pinning: ScrollPinning,
  history: HistoryLoader,
  conversationKey: string | null,
  blocksLength: number,
) {
  useLayoutEffect(() => {
    if (state.prevConversationKeyRef.current === conversationKey) return;
    recordDiagnosticEvent("scroll", { event: "conversation-changed", following: true });
    state.prevConversationKeyRef.current = conversationKey;
    state.loadGenerationRef.current += 1;
    state.loadingOlderRef.current = false;
    state.stickRef.current = true;
    history.resetIntent();
    state.setIsLoadingOlder(false);
    state.setOlderLoadError(null);
    state.setAutoScrollEnabledState(true);
    state.didFirstPaintScrollRef.current = false;
    state.viewportFillPagesRef.current = 0;
    pinning.suppressProgrammaticScrollIntent();
    pinning.stopFollowGlide();
    pinning.pinToEnd();
  }, [conversationKey, history, pinning, state]);
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
export function useJumpOwner(prepareJump: () => void): StartJump {
  const prepareRef = useRef(prepareJump);
  prepareRef.current = prepareJump;
  const cancelRef = useRef<(() => void) | null>(null);
  useEffect(() => () => cancelRef.current?.(), []);
  return useCallback((run) => {
    prepareRef.current();
    cancelRef.current?.();
    const cancel = run();
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
  const prepareJumpRef = useRef<() => void>(() => {});
  const [writer] = useState(
    () =>
      new StreamScrollWriter({
        isFollowing: () => state.stickRef.current,
        prepareJump: () => prepareJumpRef.current(),
      }),
  );
  const pinning = useScrollPinning(state, writer);
  const [anchorGuard] = useState(() => new ScrollAnchorGuard(() => state.stickRef.current));
  const history = useHistoryLoader(state);
  const callbacks = useScrollCallbacks(state, pinning, history);
  const { setAutoScrollEnabled } = pinning;
  const { resetIntent } = history;
  // A programmatic jump owns the viewport: bottom-stick lets go, and neither
  // the anchor guard nor an armed history load may pull it back.
  const prepareJump = useCallback((): void => {
    anchorGuard.suspend();
    resetIntent();
    setAutoScrollEnabled(false);
  }, [anchorGuard, resetIntent, setAutoScrollEnabled]);
  prepareJumpRef.current = prepareJump;
  const startJump = useJumpOwner(prepareJump);
  useScrollLifecycle(state, pinning, history, options.conversationKey, options.blocks.length);
  const scrollContainerRef = useAgentSessionScrollInput({
    scrollerElRef: state.scrollerElRef,
    stickRef: state.stickRef,
    writer,
    anchorGuard,
    historyLoadArmedRef: state.historyLoadArmedRef,
    lastScrollTopRef: state.lastScrollTopRef,
    userScrollIntentRef: state.userScrollIntentRef,
    suppressScrollIntentRef: state.suppressScrollIntentRef,
    armUserScrollIntent: history.armUserScrollIntent,
    setAutoScrollEnabled: pinning.setAutoScrollEnabled,
    requestOlderHistory: history.requestOlderHistory,
  });
  return useMemo(
    () => ({
      virtuosoRef: state.virtuosoRef,
      scrollContainerRef,
      itemSize: anchorGuard.measureItem,
      onStartReached: callbacks.onStartReached,
      followOutput: callbacks.followOutput,
      onAtBottomStateChange: callbacks.onAtBottomStateChange,
      onTotalListHeightChanged: callbacks.onTotalListHeightChanged,
      autoScrollEnabled: state.autoScrollEnabled,
      isLoadingOlder: state.isLoadingOlder,
      olderLoadError: state.olderLoadError,
      retryOlderHistory: history.requestOlderHistory,
      scrollToBottom: callbacks.scrollToBottom,
      startJump,
    }),
    [
      anchorGuard,
      callbacks,
      scrollContainerRef,
      startJump,
      state.autoScrollEnabled,
      state.isLoadingOlder,
      state.olderLoadError,
      state.virtuosoRef,
      history.requestOlderHistory,
    ],
  );
}
