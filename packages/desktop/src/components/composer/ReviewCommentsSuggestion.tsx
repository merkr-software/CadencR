import type { ReactElement } from "react";
import { MessageSquareCode, Plus } from "lucide-react";
import { useListDiffComments } from "@/api/generated";
import { useAgentPathMapper } from "@/hooks/useGitPathPrefix";
import { formatCommentsForAgent } from "@/lib/format-diff-comments";
import {
  composerKeyFor,
  useComposerContextItems,
  useComposerContextStore,
} from "@/stores/composer-context-store";
import { useComposerContext } from "./ComposerContext";

/**
 * Pending diff-review comments, offered as context for the next message: one
 * click attaches them to this composer's tray, so a review rides along with
 * the instruction that explains it. They leave the Git pane's pending batch
 * only once that message is sent (see `settleSentReviewComments`).
 */
export function ReviewCommentsSuggestion(): ReactElement | null {
  const { featureId } = useComposerContext();
  const key = composerKeyFor(featureId);
  const attached = useComposerContextItems(key).some((item) => item.kind === "review");
  const { data } = useListDiffComments(featureId ?? 0, { query: { enabled: featureId != null } });
  // Mounted in every composer, so an unexpected response shape (a stubbed
  // API in tests, a server mid-upgrade) must read as "no comments", not crash.
  const pending = (Array.isArray(data) ? data : []).filter(
    (comment) => comment.status === "pending",
  );
  // Comments name repository-relative paths; the agent runs in the feature's
  // directory. Offered once those can be mapped, looked up only when offered.
  const toAgentPath = useAgentPathMapper(featureId ?? 0, !attached && pending.length > 0);
  if (featureId == null || attached || pending.length === 0 || !toAgentPath) return null;

  const attach = (): void => {
    useComposerContextStore.getState().add(key, {
      kind: "review",
      label: "Review comments",
      detail: String(pending.length),
      content: formatCommentsForAgent(pending, toAgentPath),
      commentIds: pending.map((comment) => comment.id),
    });
  };

  return (
    <button
      type="button"
      onClick={attach}
      className="inline-flex h-7 items-center gap-1.5 rounded-md border border-dashed border-border px-2 text-[12px] text-muted-foreground transition-colors hover:border-solid hover:bg-muted/60 hover:text-foreground"
    >
      <MessageSquareCode className="size-3.5" />
      {pending.length} review {pending.length === 1 ? "comment" : "comments"}
      <span className="inline-flex items-center gap-0.5 font-medium text-foreground/90">
        <Plus className="size-3" />
        Attach
      </span>
    </button>
  );
}
