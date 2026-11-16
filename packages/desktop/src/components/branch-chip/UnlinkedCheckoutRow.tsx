/**
 * The branch panel's first row when the directory's checkout is not one of the
 * conversation's branches — the trunk, or a branch another conversation moved
 * the project directory to. The header names it either way; this row says why
 * it has no target or pull request here, and offers to link it.
 */
import { memo, type ReactElement } from "react";
import { GitBranchIcon, LinkIcon, Loader2Icon } from "lucide-react";

import { useLinkFeatureBranch } from "@/api/generated";
import { Button } from "@/components/ui/button";
import { toastError } from "@/lib/api-errors";

/** What `git status` reports as the branch of a detached HEAD: nothing to link. */
const DETACHED_HEAD = "(detached)";

export const UnlinkedCheckoutRow = memo(function UnlinkedCheckoutRow({
  featureId,
  name,
}: {
  featureId: number;
  name: string;
}): ReactElement {
  return (
    <li data-thread-checkout={name} className="flex flex-col gap-1 px-3 py-2">
      <div className="flex min-w-0 items-center gap-1.5">
        <GitBranchIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 truncate font-mono text-xs" title={name}>
          {name}
        </span>
        <span className="shrink-0 rounded border border-border px-1 text-[10px] text-muted-foreground">
          checked out
        </span>
        {name !== DETACHED_HEAD && <LinkCheckoutButton featureId={featureId} name={name} />}
      </div>
      <p className="pl-5 text-[11px] text-muted-foreground">
        Not one of this conversation's branches
      </p>
    </li>
  );
});

function LinkCheckoutButton({
  featureId,
  name,
}: {
  featureId: number;
  name: string;
}): ReactElement {
  const { mutate, isPending } = useLinkFeatureBranch({
    mutation: { onError: (error) => toastError(error, "Failed to link the branch.") },
  });
  return (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      className="ml-auto h-5 shrink-0 px-1.5 text-[11px] text-muted-foreground hover:text-foreground"
      aria-label={`Link ${name} to this conversation`}
      disabled={isPending}
      onClick={() => mutate({ id: featureId, data: { branch: name } })}
    >
      {isPending ? <Loader2Icon className="animate-spin" /> : <LinkIcon />}
      Link
    </Button>
  );
}
