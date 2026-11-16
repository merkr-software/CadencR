import { CircleCheck, TriangleAlert } from "lucide-react";
import type { CadencrError } from "@cadencr/tab-sdk";
import { Button, EmptyState, Skeleton } from "@cadencr/tab-kit";
import { useTabContext } from "@cadencr/tab-sdk/react";

import type { Scope } from "./useChangedFiles";

/** Treemap-shaped placeholder while the first load is in flight. */
export function TreemapSkeleton() {
  const cells = [
    "col-span-3 row-span-4",
    "col-span-2 row-span-2",
    "col-span-1 row-span-2",
    "col-span-1 row-span-2",
    "col-span-2 row-span-1",
    "col-span-1 row-span-1",
  ];
  return (
    <div role="status" className="grid h-full grid-cols-6 grid-rows-4 gap-1.5 p-3">
      <span className="sr-only">Loading changed files…</span>
      {cells.map((cell, index) => (
        <Skeleton key={index} aria-hidden="true" className={`${cell} rounded-md`} />
      ))}
    </div>
  );
}

export function NoChanges({ scope }: { scope: Scope }) {
  const { feature } = useTabContext();
  const description =
    scope === "branch"
      ? `${feature.branch ?? "This branch"} has no commits over ${feature.baseBranch ?? "its base"} yet.`
      : "The worktree matches its last commit. Edits show up here as soon as they land.";
  return (
    <EmptyState
      icon={<CircleCheck />}
      title="No changes yet"
      description={description}
      className="h-full"
    />
  );
}

export function LoadFailed({ error, onRetry }: { error: CadencrError; onRetry: () => void }) {
  return (
    <EmptyState
      icon={<TriangleAlert />}
      title="Couldn't load the changed files"
      description={error.message}
      action={
        <Button variant="outline" size="sm" onClick={onRetry}>
          Try again
        </Button>
      }
      className="h-full"
    />
  );
}
