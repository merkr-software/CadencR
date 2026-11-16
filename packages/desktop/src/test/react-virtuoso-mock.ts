import * as React from "react";

type ItemContent = (index: number, data?: unknown, context?: unknown) => unknown;
type FollowOutputScalar = "auto" | "smooth" | boolean;
type FollowOutputCallback = (isAtBottom: boolean) => FollowOutputScalar;
type FollowOutputProp = FollowOutputCallback | FollowOutputScalar;

interface VirtuosoHandleMock {
  scrollTo: (options: ScrollToOptions) => void;
  scrollToIndex: (location: { index: "LAST" | number } | number) => void;
}

interface VirtuosoProps {
  totalCount?: number;
  data?: unknown[];
  itemContent?: ItemContent;
  components?: {
    Header?: (props: { context?: unknown }) => React.ReactNode;
    Footer?: (props: { context?: unknown }) => React.ReactNode;
  };
  context?: unknown;
  scrollerRef?: (ref: HTMLElement | null) => void;
  startReached?: () => void;
  followOutput?: FollowOutputProp;
  atBottomStateChange?: (atBottom: boolean) => void;
  totalListHeightChanged?: (height: number) => void;
  style?: React.CSSProperties;
  className?: string;
  role?: React.AriaRole;
  "aria-label"?: string;
  tabIndex?: number;
  onKeyDown?: React.KeyboardEventHandler<HTMLDivElement>;
  onWheel?: React.WheelEventHandler<HTMLDivElement>;
  "data-testid"?: string;
}

interface VirtuosoEventParams {
  rootRef: React.RefObject<HTMLDivElement | null>;
  scrollerRef?: (ref: HTMLElement | null) => void;
  startReached?: () => void;
  followOutputRef: React.RefObject<FollowOutputProp | undefined>;
  atBottomChangeRef: React.RefObject<((atBottom: boolean) => void) | undefined>;
  totalListHeightChangedRef: React.RefObject<((height: number) => void) | undefined>;
  pinToBottom: () => void;
}

function useVirtuosoEvents({
  rootRef,
  scrollerRef,
  startReached,
  followOutputRef,
  atBottomChangeRef,
  totalListHeightChangedRef,
  pinToBottom,
}: VirtuosoEventParams): void {
  React.useEffect(() => {
    const root = rootRef.current;
    scrollerRef?.(root);
    if (!root) return () => scrollerRef?.(null);
    const handleStart = (): void => startReached?.();
    const handleDataChange = (): void => {
      const output = followOutputRef.current;
      const result = typeof output === "function" ? output(true) : output;
      if (result) pinToBottom();
    };
    const handleAtBottomChange = (event: Event): void => {
      const detail = (event as CustomEvent<{ atBottom: boolean }>).detail;
      atBottomChangeRef.current?.(detail?.atBottom ?? false);
    };
    const handleTotalHeightChange = (event: Event): void => {
      const detail = (event as CustomEvent<{ height: number }>).detail;
      totalListHeightChangedRef.current?.(detail?.height ?? 0);
    };
    root.addEventListener("virtuoso-start-reached", handleStart);
    root.addEventListener("virtuoso-data-changed", handleDataChange);
    root.addEventListener("virtuoso-at-bottom-change", handleAtBottomChange);
    root.addEventListener("virtuoso-total-height-change", handleTotalHeightChange);
    return () => {
      root.removeEventListener("virtuoso-start-reached", handleStart);
      root.removeEventListener("virtuoso-data-changed", handleDataChange);
      root.removeEventListener("virtuoso-at-bottom-change", handleAtBottomChange);
      root.removeEventListener("virtuoso-total-height-change", handleTotalHeightChange);
      scrollerRef?.(null);
    };
  }, [
    atBottomChangeRef,
    followOutputRef,
    pinToBottom,
    rootRef,
    scrollerRef,
    startReached,
    totalListHeightChangedRef,
  ]);
}

function useFollowOutputReplay(
  data: unknown[] | undefined,
  followOutputRef: React.RefObject<FollowOutputProp | undefined>,
  pinToBottom: () => void,
): void {
  const previousDataRef = React.useRef<unknown[] | undefined>(undefined);
  React.useEffect(() => {
    if (previousDataRef.current === data) return;
    previousDataRef.current = data;
    const output = followOutputRef.current;
    const result = typeof output === "function" ? output(true) : output;
    if (result) pinToBottom();
  }, [data, followOutputRef, pinToBottom]);
}

function renderRows(
  count: number,
  itemContent: ItemContent | undefined,
  data: unknown[] | undefined,
  context: unknown,
): React.ReactNode[] {
  return Array.from({ length: count }, (_, index) =>
    React.createElement(
      "div",
      { key: index, "data-virtuoso-row-index": index },
      itemContent ? (itemContent(index, data?.[index], context) as React.ReactNode) : null,
    ),
  );
}

export const Virtuoso = React.forwardRef<VirtuosoHandleMock, VirtuosoProps>(function VirtuosoMock(
  {
    totalCount,
    data,
    itemContent,
    components,
    context,
    scrollerRef,
    startReached,
    followOutput,
    atBottomStateChange,
    totalListHeightChanged,
    style,
    className,
    role,
    "aria-label": ariaLabel,
    tabIndex,
    onKeyDown,
    onWheel,
    "data-testid": testId,
  },
  ref,
) {
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  const followOutputRef = React.useRef(followOutput);
  const atBottomChangeRef = React.useRef(atBottomStateChange);
  const totalListHeightChangedRef = React.useRef(totalListHeightChanged);
  followOutputRef.current = followOutput;
  atBottomChangeRef.current = atBottomStateChange;
  totalListHeightChangedRef.current = totalListHeightChanged;

  const pinToBottom = React.useCallback((): void => {
    const root = rootRef.current;
    if (!root) return;
    root.scrollTop = root.scrollHeight;
    atBottomChangeRef.current?.(true);
  }, []);
  React.useImperativeHandle(
    ref,
    () => ({
      scrollTo: ({ top }) => {
        const root = rootRef.current;
        if (root && top != null) root.scrollTop = top;
      },
      scrollToIndex: (location) => {
        const index = typeof location === "number" ? location : location.index;
        if (index === "LAST") pinToBottom();
      },
    }),
    [pinToBottom],
  );
  useVirtuosoEvents({
    rootRef,
    scrollerRef,
    startReached,
    followOutputRef,
    atBottomChangeRef,
    totalListHeightChangedRef,
    pinToBottom,
  });
  useFollowOutputReplay(data, followOutputRef, pinToBottom);

  const count = data?.length ?? totalCount ?? 0;
  const header = components?.Header
    ? React.createElement(components.Header, { context } as { context?: unknown })
    : null;
  const footer = components?.Footer
    ? React.createElement(components.Footer, { context } as { context?: unknown })
    : null;
  return React.createElement(
    "div",
    {
      ref: rootRef,
      "data-testid": testId ?? "virtuoso-mock",
      className,
      style,
      role,
      "aria-label": ariaLabel,
      tabIndex,
      onKeyDown,
      onWheel,
    },
    header,
    // Real Virtuoso renders its rows inside this list; the agent stream's
    // growth observer pins the bottom from its mutations.
    React.createElement(
      "div",
      { "data-testid": "virtuoso-item-list" },
      ...renderRows(count, itemContent, data, context),
    ),
    footer,
  );
});
