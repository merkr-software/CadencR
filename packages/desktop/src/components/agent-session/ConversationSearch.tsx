import { memo, type RefObject } from "react";
import type { VirtuosoHandle } from "react-virtuoso";
import type { DisplayItem } from "@/components/agentStreamDisplay";
import { useScopedGlobalShortcutById } from "@/hooks/useShortcut";
import { useConversationSearch } from "@/hooks/useConversationSearch";
import { ConversationSearchBar } from "./ConversationSearchBar";

interface ConversationSearchProps {
  /** Whether the agent tab is focused — gates both the shortcut and the bar. */
  enabled: boolean;
  items: readonly DisplayItem[];
  virtuosoRef: RefObject<VirtuosoHandle | null>;
  scrollerRef: RefObject<HTMLElement | null>;
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
  virtuosoRef,
  scrollerRef,
}: ConversationSearchProps) {
  const search = useConversationSearch({ items, virtuosoRef, scrollerRef });

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
