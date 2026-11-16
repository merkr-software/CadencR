import { useMemo, useState, type ReactElement } from "react";
import { GitBranch, GitPullRequest, Plus, X } from "lucide-react";
import { useLookupFeatureRepoPr } from "@/api/generated";
import {
  composerKeyFor,
  useComposerContextItems,
  useComposerContextStore,
} from "@/stores/composer-context-store";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { useComposerContext, useComposerDraftText } from "./ComposerContext";

const PR_LINK = /https?:\/\/[^\s)]+?\/(?:pull|pulls|merge_requests|pull-requests)\/(\d+)/i;
const MAX_BODY = 4000;
const LOOKUP_DEBOUNCE_MS = 400;

/** `host/owner/repo` of a forge link, for comparing a pasted link to the repo's. */
function repoOf(url: string): string {
  const match =
    /^https?:\/\/([^/]+)\/(.+?)\/(?:-\/)?(?:pull|pulls|merge_requests|pull-requests)\//i.exec(url);
  return match ? `${match[1]}/${match[2]}`.toLowerCase() : "";
}

/**
 * A pull request link in the draft becomes an offer: attach its title,
 * branches and description as context, and — before the first prompt — start
 * the conversation from its branch. Only links to this conversation's own
 * repository are resolved (the forge vouches for them).
 */
export function PullRequestLinkSuggestion(): ReactElement | null {
  const { featureId, isFirstPrompt, startOnBranch } = useComposerContext();
  // Settled text only: typing `/pull/123` must not look up #1, then #12.
  const draftText = useDebouncedValue(useComposerDraftText(), LOOKUP_DEBOUNCE_MS);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const key = composerKeyFor(featureId);
  const items = useComposerContextItems(key);
  const match = useMemo(() => PR_LINK.exec(draftText), [draftText]);
  const link = match?.[0] ?? null;
  const prNumber = match ? Number(match[1]) : 0;
  const { data: pr } = useLookupFeatureRepoPr(
    { feature_id: featureId ?? 0, pr_number: prNumber },
    { query: { enabled: !!link && featureId != null && prNumber > 0, retry: false } },
  );
  if (!link || !pr || dismissed === link) return null;
  if (repoOf(pr.url) !== repoOf(link)) return null;
  if (items.some((item) => item.kind === "pull_request" && item.content.includes(pr.url))) {
    return null;
  }

  const attach = (): void => {
    const body =
      pr.body_markdown.length > MAX_BODY
        ? `${pr.body_markdown.slice(0, MAX_BODY)}…`
        : pr.body_markdown;
    useComposerContextStore.getState().add(key, {
      kind: "pull_request",
      label: `${pr.pr_label} #${pr.number}`,
      detail: pr.title,
      content: `${pr.title}\n${pr.url}\nBranch: ${pr.source_branch} → ${pr.target_branch}\n\n${body}`,
    });
  };

  return (
    <span className="inline-flex h-7 max-w-full items-center gap-1 rounded-md border border-dashed border-border pr-1 pl-2 text-[12px] text-muted-foreground">
      <GitPullRequest className="size-3.5 shrink-0" />
      <span className="truncate">
        #{pr.number} {pr.title}
      </span>
      <button
        type="button"
        onClick={attach}
        className="composer-instrument h-6 gap-0.5 px-1.5 text-foreground"
      >
        <Plus className="size-3" />
        Attach
      </button>
      {isFirstPrompt && startOnBranch && (
        <button
          type="button"
          onClick={() => startOnBranch(pr.source_branch)}
          className="composer-instrument h-6 gap-1 px-1.5 text-[var(--chip-worktree-fg)]"
          title={`Work on ${pr.source_branch} in its own worktree`}
        >
          <GitBranch className="size-3" />
          Use its branch
        </button>
      )}
      <button
        type="button"
        aria-label="Dismiss"
        onClick={() => setDismissed(link)}
        className="flex size-5 items-center justify-center rounded hover:bg-muted"
      >
        <X className="size-3" />
      </button>
    </span>
  );
}
