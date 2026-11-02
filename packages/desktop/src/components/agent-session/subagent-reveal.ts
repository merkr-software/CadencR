import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useSyncExternalStore,
  type RefCallback,
  type RefObject,
} from "react";
import type { VirtuosoHandle } from "react-virtuoso";
import type { AgentBlockData } from "@/types/agent-block";
import type { DisplayItem } from "@/types/agent-stream";
import type { StartJump } from "./agent-session-scroll-utils";
import { jumpToRow } from "./message-navigator-scroll";
import type { SubagentCards } from "./subagent-cards";

/**
 * What links a session's transcript and its composer's agent list, provided
 * by `AgentSession`: the cards' bridge, and the session's one jump owner for
 * the transcript's revealer. Absent outside a session: the list then shows
 * every running agent and a reveal reports false.
 */
export interface SubagentLink {
  cards: SubagentCards;
  startJump: StartJump;
}

export const SubagentLinkContext = createContext<SubagentLink | null>(null);

function holdsCarrier(block: AgentBlockData, toolUseId: string): boolean {
  if (block.toolUseId === toolUseId) return true;
  return block.childBlocks?.some((child) => holdsCarrier(child, toolUseId)) ?? false;
}

/**
 * Row holding a sub-agent's card: its own for a top-level carrier, its root
 * ancestor's for a nested one (nested cards render inside their parent's).
 * Carriers never fold into a compact flow, so only block rows are searched.
 */
export function findSubagentRow(
  items: readonly DisplayItem[],
  toolUseId: string,
): { rowIndex: number; blockId: string } | null {
  for (const [rowIndex, item] of items.entries()) {
    if (item.kind === "block" && holdsCarrier(item.block, toolUseId)) {
      return { rowIndex, blockId: item.block.id };
    }
  }
  return null;
}

/**
 * Lends the transcript to the cards' bridge while mounted: its scroller (what
 * "on screen" means) and its revealer, which scrolls the row holding a card
 * to the top and flashes the card itself (its root card when it is nested in
 * a closed parent).
 */
export function useSubagentCardsStream(
  items: readonly DisplayItem[],
  virtuosoRef: RefObject<VirtuosoHandle | null>,
  scrollerRef: RefObject<HTMLElement | null>,
): void {
  const link = useContext(SubagentLinkContext);
  // Read at click time: `items` changes on every streaming delta.
  const itemsRef = useRef(items);
  itemsRef.current = items;
  // The stream can unmount while the session stays: stop its jump then.
  const cancelRef = useRef<(() => void) | null>(null);
  useEffect(() => () => cancelRef.current?.(), []);

  useEffect(() => {
    if (!link) return;
    const { cards, startJump } = link;
    return cards.attach({
      getScroller: () => scrollerRef.current,
      reveal: (toolUseId) => {
        const scroller = scrollerRef.current;
        const row = findSubagentRow(itemsRef.current, toolUseId);
        if (!scroller || !row) return false;
        cancelRef.current = startJump(() =>
          jumpToRow({
            scroller,
            virtuoso: virtuosoRef.current,
            blockId: row.blockId,
            rowIndex: row.rowIndex,
            flashSelectors: [
              `[data-subagent-id="${CSS.escape(toolUseId)}"]`,
              '[data-tool-family="task"]',
            ],
          }),
        );
        return true;
      },
    });
  }, [link, scrollerRef, virtuosoRef]);
}

/** Ref for a sub-agent's card: reports it to the bridge while mounted. */
export function useSubagentCardRef(toolUseId: string | undefined): RefCallback<HTMLElement> {
  const cards = useContext(SubagentLinkContext)?.cards;
  return useCallback(
    (element: HTMLElement | null) => {
      if (!element || !cards || !toolUseId) return;
      return cards.track(element, toolUseId);
    },
    [cards, toolUseId],
  );
}

const NO_CARDS: ReadonlySet<string> = new Set();
const noSubscription = (): (() => void) => () => {};
const noCards = (): ReadonlySet<string> => NO_CARDS;

/** For the composer's agent list: which cards show now, and how to reach one. */
export function useSubagentCards(): {
  onScreen: ReadonlySet<string>;
  reveal: (toolUseId: string) => boolean;
} {
  const cards = useContext(SubagentLinkContext)?.cards;
  const onScreen = useSyncExternalStore(
    cards?.subscribe ?? noSubscription,
    cards?.getVisible ?? noCards,
  );
  const reveal = useCallback(
    (toolUseId: string): boolean => cards?.reveal(toolUseId) ?? false,
    [cards],
  );
  return { onScreen, reveal };
}
