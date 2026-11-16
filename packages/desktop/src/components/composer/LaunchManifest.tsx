import { memo, type ReactElement } from "react";
import { useGetProjectSettings } from "@/api/generated";
import { settingsArrayToMap } from "@/api/settings";
import { createsBranch } from "@/lib/worktree-mode";
import { WorktreeChip, type WorktreeChipProps } from "../agent-session/WorktreeChip";

const DEFAULT_BRANCH_PREFIX = "feature/";

/**
 * The first prompt's launch line, at the top of the composer card: where the
 * agent will write code, stated as one editable sentence —
 * "Runs in [New worktree] from [main] · branch feature/… named from your prompt".
 *
 * It answers the heaviest decision of a new conversation before Send, not
 * after: a new branch's name is shown as its prefix plus an honest "named
 * from your prompt" (the backend names it from the auto-generated title).
 * Working in the project folder is a legitimate choice, so it gets no warning.
 */
export const LaunchManifest = memo(function LaunchManifest(
  props: WorktreeChipProps,
): ReactElement | null {
  const { worktreeProjectId, worktreeMode } = props;
  const { data: projectSettings } = useGetProjectSettings(worktreeProjectId ?? 0, {
    query: { enabled: worktreeProjectId != null && createsBranch(worktreeMode) },
  });
  if (worktreeProjectId == null || !worktreeMode) return null;
  const prefix =
    settingsArrayToMap(projectSettings)["branch_prefix"]?.trim() || DEFAULT_BRANCH_PREFIX;

  return (
    <div
      data-launch-manifest
      className="mx-1.5 flex flex-wrap items-center gap-x-1 gap-y-1 border-b border-border/60 px-1.5 pt-2 pb-2 text-[12px] text-muted-foreground"
    >
      <span className="mr-0.5">Runs in</span>
      <WorktreeChip {...props} variant="manifest" />
      {createsBranch(worktreeMode) && (
        <span className="inline-flex min-w-0 items-center gap-1">
          <span aria-hidden>·</span>
          branch
          <code className="truncate font-mono text-[11.5px] text-foreground/80">{prefix}…</code>
          named from your prompt
        </span>
      )}
    </div>
  );
});
