import { memo, type ReactElement, type RefObject } from "react";
import type { VirtuosoHandle } from "react-virtuoso";
import type { AgentBlockData } from "@/types/agent-block";
import type { DisplayItem } from "@/types/agent-stream";
import { ConversationSearch } from "./ConversationSearch";
import { MessageNavigator } from "./MessageNavigator";
import type { MessageNavigatorControls } from "./useMessageNavigator";
import { useSubagentCardsStream } from "./subagent-reveal";

interface AgentStreamToolsProps {
  items: DisplayItem[];
  toolResultMap: Map<string, AgentBlockData>;
  virtuosoRef: RefObject<VirtuosoHandle | null>;
  scrollerRef: RefObject<HTMLElement | null>;
  /** Agent tab focused: gates ⌘F search and the navigator's ⌥↑ / ⌥↓. */
  shortcutsEnabled: boolean;
  /** Null hides the prompt rail (Settings → Appearance → Agent transcript). */
  messageNavigator: MessageNavigatorControls | null;
  /** Block holding the active search match, or null. */
  onSearchBlockChange: (blockId: string | null) => void;
}

/**
 * What finds and jumps through the transcript: ⌘F search, the prompt rail,
 * and the cards' link behind the composer's agent list.
 */
export const AgentStreamTools = memo(function AgentStreamTools({
  items,
  toolResultMap,
  virtuosoRef,
  scrollerRef,
  shortcutsEnabled,
  messageNavigator,
  onSearchBlockChange,
}: AgentStreamToolsProps): ReactElement {
  useSubagentCardsStream(items, virtuosoRef, scrollerRef);
  return (
    <>
      {shortcutsEnabled && (
        <ConversationSearch
          enabled
          items={items}
          toolResultMap={toolResultMap}
          virtuosoRef={virtuosoRef}
          scrollerRef={scrollerRef}
          onActiveBlockChange={onSearchBlockChange}
        />
      )}
      {messageNavigator && (
        <MessageNavigator
          items={items}
          virtuosoRef={virtuosoRef}
          scrollerRef={scrollerRef}
          controls={messageNavigator}
          shortcutsEnabled={shortcutsEnabled}
        />
      )}
    </>
  );
});
