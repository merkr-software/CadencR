import { useUiTranslation } from "@/lib/i18n/ui";
import type { ReactElement } from "react";

import { Skeleton } from "@/components/ui/skeleton";

/**
 * Stand-in for a transcript whose saved history has not arrived: a few lines
 * where the last messages will be. Shown only when a conversation is opened
 * before its history could be preloaded (see `lib/conversation-preload`).
 */
export function TranscriptLoading(): ReactElement {
  const { t } = useUiTranslation();
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label={t(
        "conversation.stream.transcriptLoading.loadingConversation",
        "Loading conversation",
      )}
      className="flex min-h-0 flex-1 flex-col justify-end gap-3 px-4 pb-10"
    >
      <Skeleton className="h-4 w-3/4" />
      <Skeleton className="h-4 w-1/2" />
      <Skeleton className="h-4 w-2/3" />
    </div>
  );
}
