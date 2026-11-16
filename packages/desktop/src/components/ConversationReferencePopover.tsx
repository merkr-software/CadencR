import { memo } from "react";
import { ArchiveIcon, Loader2Icon, MessageSquareIcon } from "lucide-react";
import { apiErrorMessage } from "@/lib/api-errors";
import { FeatureStatus } from "@/api/generated";
import type { ConversationReferenceItem } from "@/hooks/useConversationReference";
import { ComposerPopover, ComposerPopoverOption } from "./composer/ComposerPopover";

interface ConversationReferencePopoverProps {
  listId: string;
  items: ConversationReferenceItem[];
  selectedIndex: number;
  isLoading: boolean;
  error: unknown;
  disabled: boolean;
  onSelect: (featureId: number) => void;
  maxHeight?: number;
}

const ConversationReferenceRow = memo(function ConversationReferenceRow({
  listId,
  index,
  item,
  selected,
  onSelect,
}: {
  listId: string;
  index: number;
  item: ConversationReferenceItem;
  selected: boolean;
  onSelect: (featureId: number) => void;
}) {
  return (
    <ComposerPopoverOption
      listId={listId}
      index={index}
      selected={selected}
      onSelect={() => onSelect(item.feature_id)}
    >
      <MessageSquareIcon className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate font-medium">{item.feature_title}</span>
      <span className="max-w-[40%] shrink-0 truncate text-xs text-muted-foreground">
        {item.project_name}
      </span>
      {item.feature_status === FeatureStatus.archived && (
        <ArchiveIcon className="size-3 shrink-0 text-muted-foreground" aria-label="Archived" />
      )}
    </ComposerPopoverOption>
  );
});

export function ConversationReferencePopover({
  listId,
  items,
  selectedIndex,
  isLoading,
  error,
  disabled,
  onSelect,
  maxHeight,
}: ConversationReferencePopoverProps) {
  let status: React.ReactNode = null;
  if (isLoading)
    status = (
      <>
        <Loader2Icon className="size-3 animate-spin" />
        Loading conversations…
      </>
    );
  else if (disabled)
    status = "Enable the workspace MCP in Settings → MCP to reference conversations.";
  else if (error) status = apiErrorMessage(error, "Could not load conversations");
  else if (items.length === 0) status = "No matching conversations";

  return (
    <ComposerPopover listId={listId} label="Conversations" status={status} maxHeight={maxHeight}>
      {items.map((item, index) => (
        <ConversationReferenceRow
          key={item.feature_id}
          listId={listId}
          index={index}
          item={item}
          selected={index === selectedIndex}
          onSelect={onSelect}
        />
      ))}
    </ComposerPopover>
  );
}
