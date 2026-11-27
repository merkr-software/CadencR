import type { ReactElement } from "react";
import { GitCommit } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useGitCommitDisabledReason } from "@/components/git-actions/useGitCommitDisabledReason";
import { useUiTranslation } from "@/lib/i18n/ui";
import { runShortcutActionOutcome } from "@/lib/command-palette/shortcut-actions";
import { selectGitUncommittedCount, useGitStatusStore } from "@/stores/useGitStatusStore";

/**
 * The phone Git list's bottom bar while the working tree has changes: their
 * count and a 44px Commit that runs the header's commit (the same dialog, run
 * and shortcut as the "…" sheet's Commit) through the `git-commit` shortcut
 * action, which only the workspace on screen registers: kept-alive
 * workspaces and other headers for the conversation never open a second
 * dialog. When Commit is unavailable, a tap says why instead of doing
 * nothing. It sits above the tab bar, which owns the home indicator inset,
 * and steps aside with the on-screen keyboard.
 */
export function PhoneCommitBar({ featureId }: { featureId: number }): ReactElement | null {
  const { t } = useUiTranslation();
  const count = useGitStatusStore(selectGitUncommittedCount(featureId));
  const disabledReason = useGitCommitDisabledReason(featureId);
  if (!count) return null;
  const commit = (): void => {
    // The header's handler decides (it also reopens a commit still running);
    // only when it passes does the bar say why.
    const outcome = runShortcutActionOutcome("git-commit");
    if (outcome === "missing")
      toast.error(t("workspace.git.phoneCommitBar.unavailable", "Commit isn't available here"));
    else if (outcome === "declined") {
      toast.error(t("workspace.git.phoneCommitBar.cannotCommit", "Cannot commit"), {
        description: disabledReason ?? undefined,
      });
    }
  };
  return (
    <div
      data-phone-commit-bar
      className="flex shrink-0 items-center gap-3 border-t border-border bg-background pt-2 pr-3 pl-4 pb-[calc(0.5rem+var(--app-inset-bottom))] [html[data-keyboard-open]_&]:hidden"
    >
      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
        {t("workspace.git.gitTabToggle.uncommittedCount", "{{count, number}} uncommitted changes", {
          count,
          defaultValue_one: "{{count, number}} uncommitted change",
        })}
      </span>
      <Button className="h-11 px-5" onClick={commit}>
        <GitCommit />
        {t("workspace.git.gitActionPopover.commit", "Commit")}
      </Button>
    </div>
  );
}
