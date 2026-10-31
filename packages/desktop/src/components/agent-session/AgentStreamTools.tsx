import { memo, type ReactElement, type RefObject } from "react";
import type { VirtuosoHandle } from "react-virtuoso";
import type { AgentBlockData } from "@/types/agent-block";
import type { DisplayItem } from "@/types/agent-stream";
import { ConversationSearch } from "./ConversationSearch";
import { MessageNavigator } from "./MessageNavigator";
import type { MessageNavigatorControls } from "./useMessageNavigator";

interface AgentStreamToolsProps {
  items: DisplayItem[];
  toolResultMap: Map<string, AgentBlockData>;
  virtuosoRef: RefObject<VirtuosoHandle | null>;
  scrollerRef: RefObject<HTMLElement | null>;
  /** Agent tab focused: gates ⌘F search and the navigator's ⌥↑ / ⌥↓. */
  shortcutsEnabled: boolean;
  /** Null hides the prompt rail (Settings → Interface). */
  messageNavigator: MessageNavigatorControls | null;
  /** Block holding the active search match, or null. */
  onSearchBlockChange: (blockId: string | null) => void;
}

/** Overlays that find and jump through the transcript: ⌘F search and the prompt rail. */
export const AgentStreamTools = memo(function AgentStreamTools({
  items,
  toolResultMap,
  virtuosoRef,
  scrollerRef,
  shortcutsEnabled,
  messageNavigator,
  onSearchBlockChange,
}: AgentStreamToolsProps): ReactElement {
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
