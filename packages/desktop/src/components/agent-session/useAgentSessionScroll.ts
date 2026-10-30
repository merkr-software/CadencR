import { recordDiagnosticEvent } from "@/lib/renderer-diagnostics";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import type { FollowOutputCallback, VirtuosoHandle } from "react-virtuoso";
import type { AgentBlockData } from "@/types/agent-block";
import { isAutoScrollPinSuppressed } from "@/lib/agent-scroll-suppression";
import { isIos } from "@/lib/is-ios";
import { subscribeResize } from "@/lib/resize-coordinator";
import {
  canScrollStream,
  MAX_VIEWPORT_FILL_PAGES,
  pinToBottom,
  type UseAgentSessionScrollResult,
} from "./agent-session-scroll-utils";
import { ScrollAnchorGuard } from "./stream-scroll-anchor";
import { useAgentSessionScrollInput } from "./useAgentSessionScrollInput";

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
      onLoadOlderRef,
      prevConversationKeyRef,
      scrollerElRef,
      setAutoScrollEnabledState,
      setIsLoadingOlder,
      stickRef,
      suppressScrollIntentRef,
      userScrollIntentRef,
      viewportFillPagesRef,
      virtuosoRef,
    }),
    [autoScrollEnabled, isLoadingOlder],
  );
}

type ScrollState = ReturnType<typeof useScrollState>;

function useScrollPinning(state: ScrollState) {
  const setAutoScrollEnabled = useCallback(
    (enabled: boolean): void => {
      if (state.stickRef.current === enabled) return;
      recordDiagnosticEvent("scroll", { following: enabled });
      state.stickRef.current = enabled;
      state.setAutoScrollEnabledState(enabled);
    },
    [state.setAutoScrollEnabledState, state.stickRef],
  );
  const pinScrollerToEnd = useCallback((): void => {
    // On iOS, Virtuoso owns bottom pinning through its deviation-aware
    // `followOutput` path. A raw scrollTop write can fight that correction and
    // feed a synchronous scroll/measurement loop back into React.
    if (isIos()) return;
    const element = state.scrollerElRef.current;
    if (!element || !state.stickRef.current) return;
    pinToBottom(element);
  }, [state.scrollerElRef, state.stickRef]);
  const pinToEnd = useCallback((): void => {
    state.virtuosoRef.current?.scrollToIndex({
      index: "LAST",
      align: "end",
      behavior: "auto",
    });
    requestAnimationFrame(pinScrollerToEnd);
  }, [pinScrollerToEnd, state.virtuosoRef]);
  const suppressProgrammaticScrollIntent = useCallback((): void => {
    state.suppressScrollIntentRef.current = true;
    requestAnimationFrame(() => {
      state.lastScrollTopRef.current =
        state.scrollerElRef.current?.scrollTop ?? state.lastScrollTopRef.current;
      state.suppressScrollIntentRef.current = false;
    });
  }, [state.lastScrollTopRef, state.scrollerElRef, state.suppressScrollIntentRef]);
  return useMemo(
    () => ({ pinToEnd, setAutoScrollEnabled, suppressProgrammaticScrollIntent }),
    [pinToEnd, setAutoScrollEnabled, suppressProgrammaticScrollIntent],
  );
}

type ScrollPinning = ReturnType<typeof useScrollPinning>;

function useHistoryLoader(state: ScrollState) {
  // Depends on the refs it reads rather than on `state`, which is rebuilt on
  // every stick and loading toggle: `onScroll` closes over this, and with it the
  // scroller ref, whose identity must hold (see `useScrollContainerRef`).
  const requestOlderHistory = useCallback((): void => {
    const loadOlder = state.onLoadOlderRef.current;
    if (!state.hasMoreRef.current || !loadOlder || state.loadingOlderRef.current) return;
    const generation = state.loadGenerationRef.current;
    state.loadingOlderRef.current = true;
    state.setIsLoadingOlder(true);
    void loadOlder()
      .then(() => {
        if (generation !== state.loadGenerationRef.current) return;
        state.historyLoadArmedRef.current = false;
        state.userScrollIntentRef.current = false;
        state.loadingOlderRef.current = false;
        state.setIsLoadingOlder(false);
      })
      .catch(() => {
        if (generation !== state.loadGenerationRef.current) return;
        state.historyLoadArmedRef.current = false;
        state.userScrollIntentRef.current = false;
        state.loadingOlderRef.current = false;
        state.setIsLoadingOlder(false);
        toast.error("Failed to load older messages");
      });
  }, [
    state.hasMoreRef,
    state.historyLoadArmedRef,
    state.loadGenerationRef,
    state.loadingOlderRef,
    state.onLoadOlderRef,
    state.setIsLoadingOlder,
    state.userScrollIntentRef,
  ]);
  const maybeFillViewport = useCallback((): void => {
    if (!state.stickRef.current || state.loadingOlderRef.current) return;
    if (!state.hasMoreRef.current || !state.onLoadOlderRef.current) return;
    if (state.viewportFillPagesRef.current >= MAX_VIEWPORT_FILL_PAGES) return;
    const element = state.scrollerElRef.current;
    if (!element || canScrollStream(element)) return;
    state.viewportFillPagesRef.current += 1;
    requestOlderHistory();
  }, [requestOlderHistory, state]);
  const resetIntent = useCallback((): void => {
    state.historyLoadArmedRef.current = false;
    state.userScrollIntentRef.current = false;
    state.lastScrollTopRef.current = state.scrollerElRef.current?.scrollTop ?? 0;
  }, [state]);
  const armUserScrollIntent = useCallback((): void => {
    state.userScrollIntentRef.current = true;
  }, [state.userScrollIntentRef]);
  return useMemo(
    () => ({ armUserScrollIntent, maybeFillViewport, requestOlderHistory, resetIntent }),
    [armUserScrollIntent, maybeFillViewport, requestOlderHistory, resetIntent],
  );
}

type HistoryLoader = ReturnType<typeof useHistoryLoader>;

function useScrollCallbacks(state: ScrollState, pinning: ScrollPinning, history: HistoryLoader) {
  const scrollToBottom = useCallback((): void => {
    history.resetIntent();
    pinning.setAutoScrollEnabled(true);
    pinning.pinToEnd();
  }, [history, pinning]);
  const followOutput = useCallback<FollowOutputCallback>(
    () => (state.stickRef.current && !isAutoScrollPinSuppressed() ? "auto" : false),
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
      // Reissuing scrollToIndex from Virtuoso's own height callback closes a
      // feedback loop on iOS WebKit. `followOutput` already owns that platform's
      // streaming bottom pin; viewport backfill remains independent below.
      if (!isIos()) pinning.pinToEnd();
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
    state.setAutoScrollEnabledState(true);
    state.didFirstPaintScrollRef.current = false;
    state.viewportFillPagesRef.current = 0;
    pinning.suppressProgrammaticScrollIntent();
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

export function useAgentSessionScroll(
  options: UseAgentSessionScrollOptions,
): UseAgentSessionScrollResult {
  const state = useScrollState(options);
  const pinning = useScrollPinning(state);
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
  useScrollLifecycle(state, pinning, history, options.conversationKey, options.blocks.length);
  const scrollContainerRef = useAgentSessionScrollInput({
    scrollerElRef: state.scrollerElRef,
    stickRef: state.stickRef,
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
      scrollToBottom: callbacks.scrollToBottom,
      prepareJump,
    }),
    [
      anchorGuard,
      callbacks,
      prepareJump,
      scrollContainerRef,
      state.autoScrollEnabled,
      state.isLoadingOlder,
      state.virtuosoRef,
    ],
  );
}
