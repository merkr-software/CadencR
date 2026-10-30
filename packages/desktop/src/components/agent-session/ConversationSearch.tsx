import { memo, useEffect, type RefObject } from "react";
import type { VirtuosoHandle } from "react-virtuoso";
import type { AgentBlockData } from "@/types/agent-block";
import type { DisplayItem } from "@/types/agent-stream";
import { useScopedGlobalShortcutById } from "@/hooks/useShortcut";
import { useConversationSearch } from "@/hooks/useConversationSearch";
import { useFeatureLayoutContext } from "@/components/feature-layout/FeatureLayoutContext";
import {
  isFreshFindRequest,
  takeConversationFind,
  useConversationFindRequestStore,
} from "@/stores/conversation-find-request-store";
import { ConversationSearchBar } from "./ConversationSearchBar";

interface ConversationSearchProps {
  /** Whether the agent tab is focused — gates both the shortcut and the bar. */
  enabled: boolean;
  items: readonly DisplayItem[];
  /** Paired tool results — Bash rows are searched on the output they render. */
  toolResultMap?: ReadonlyMap<string, AgentBlockData>;
  virtuosoRef: RefObject<VirtuosoHandle | null>;
  scrollerRef: RefObject<HTMLElement | null>;
  /** Reports the block holding the active match (null when none or closed). */
  onActiveBlockChange?: (blockId: string | null) => void;
}

/**
 * Hosts the find-in-conversation experience: binds ⌘F / Ctrl+F in the `agent`
 * scope (capture-phase, so it beats the prompt editor) and renders the search
 * bar over the virtualized stream when open. All match state and highlighting
 * lives in {@link useConversationSearch}.
 */
export const ConversationSearch = memo(function ConversationSearch({
  enabled,
  items,
  toolResultMap,
  virtuosoRef,
  scrollerRef,
  onActiveBlockChange,
}: ConversationSearchProps) {
  const search = useConversationSearch({ items, toolResultMap, virtuosoRef, scrollerRef });
  useTakeFindRequest(search.openSearch, search.setQuery);
  const { activeBlockId } = search;
  useEffect(() => {
    onActiveBlockChange?.(activeBlockId);
    return () => onActiveBlockChange?.(null);
  }, [activeBlockId, onActiveBlockChange]);

  useScopedGlobalShortcutById(
    "conversation-search",
    (event) => {
      event.preventDefault();
      event.stopPropagation();
      search.openSearch();
    },
    "agent",
    { enabled },
  );

  if (!search.isOpen) return null;

  return (
    <ConversationSearchBar
      query={search.query}
      matchCount={search.matchCount}
      activeNumber={search.activeNumber}
      focusNonce={search.focusNonce}
      onQueryChange={search.setQuery}
      onNext={search.next}
      onPrev={search.prev}
      onClose={search.closeSearch}
    />
  );
});

/**
 * Opens the find bar on a query the command palette asked for (a message hit
 * in this conversation), once, if the request is still fresh.
 */
function useTakeFindRequest(openSearch: () => void, setQuery: (query: string) => void): void {
  const featureId = useFeatureLayoutContext()?.featureId;
  const request = useConversationFindRequestStore((state) =>
    featureId != null && state.request?.featureId === featureId ? state.request : null,
  );
  useEffect(() => {
    if (!request) return;
    takeConversationFind(request.nonce);
    if (!isFreshFindRequest(request, Date.now())) return;
    openSearch();
    setQuery(request.query);
  }, [openSearch, request, setQuery]);
}
