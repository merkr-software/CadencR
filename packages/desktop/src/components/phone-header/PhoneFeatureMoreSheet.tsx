import { useRef, type ReactElement } from "react";
import { EllipsisIcon, Loader2Icon } from "lucide-react";

import { useUiTranslation, type UiTranslator } from "@/lib/i18n/ui";

import type { CustomAction } from "@/api/generated";
import { CustomActionSheetRow } from "@/components/custom-actions/MobileCustomActionsSheet";
import { FeatureLabelChip } from "@/components/FeatureLabelChip";
import type { GitActionController } from "@/components/git-actions/useGitActionController";
import {
  refreshingGitStatusLabel,
  retryGitStatusLabel,
  type GitStatusRetry,
} from "@/components/git-actions/GitActionPopoverContent";
import { activeGitActivity, type GitAction } from "@/components/git-actions/useGitAction";
import { PhoneSheetContent, PhoneSheetHeading } from "@/components/PhoneSheet";
import { Button } from "@/components/ui/button";
import { Dialog, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { useFeatureCustomActions } from "@/hooks/useFeatureCustomActions";
import type { WorktreeSetupHeaderProps } from "@/components/WorktreeSetupHeader";
import { apiErrorMessage } from "@/lib/api-errors";
import { aggregateRunState } from "@/lib/custom-actions/run-state";
import { cn } from "@/lib/utils";
import { useCustomActionsUiStore } from "@/stores/custom-actions-ui-store";

import { PhoneBranchSection } from "./PhoneBranchSection";
import { PhoneGitActionList } from "./PhoneGitActionList";

interface PhoneFeatureMoreSheetProps {
  featureId: number;
  projectId: number;
  git: GitActionController;
  /** The worktree's summary (the desktop header's second line), when it has one. */
  worktree: WorktreeSetupHeaderProps | null;
  featureLabel: string | null;
  showCustomActions: boolean;
}

/**
 * The phone header's "…": one sheet for what the desktop header spreads over
 * its title line, its second line and its right side — the label, the branch
 * (copy, the conversation's branches), the worktree's state, the Git actions
 * and the custom actions. Its open state is the Git picker's
 * (`useGitActionController`), so the Git actions shortcut opens it too.
 * Picking something that opens its own dialog closes the sheet without handing
 * focus back to "…" under that dialog.
 */
export function PhoneFeatureMoreSheet({
  featureId,
  projectId,
  git,
  worktree,
  featureLabel,
  showCustomActions,
}: PhoneFeatureMoreSheetProps): ReactElement {
  const { t } = useUiTranslation();
  // The header's launcher owns the fallback poll; this only reads the list.
  const customActions = useFeatureCustomActions(projectId, featureId, {
    enabled: showCustomActions,
    poll: false,
  });
  const actions = showCustomActions ? (customActions.data ?? []) : [];
  const handingOffRef = useRef(false);
  const handOff = (): void => {
    handingOffRef.current = true;
    git.setPickerOpen(false);
  };
  const flag = moreFlag(git, actions, t);
  return (
    <Dialog open={git.pickerOpen} onOpenChange={git.setPickerOpen}>
      <MoreSheetTrigger flag={flag} />
      <PhoneSheetContent
        onCloseAutoFocus={(event) => {
          if (!handingOffRef.current) return;
          handingOffRef.current = false;
          event.preventDefault();
        }}
      >
        <DialogTitle className="sr-only">
          {t("phone.header.actions", "Conversation actions")}
        </DialogTitle>
        <DialogDescription className="sr-only">
          {t(
            "phone.header.actionsDescription",
            "Branch, worktree, Git and custom actions for this conversation.",
          )}
        </DialogDescription>
        <div className="flex flex-col overflow-y-auto px-2 pt-2 pb-3">
          {featureLabel && (
            <div className="flex min-h-11 items-center px-2">
              <FeatureLabelChip label={featureLabel} className="max-w-full" />
            </div>
          )}
          <PhoneSheetHeading className="px-2">
            {t("palette.preview.branch", "Branch")}
          </PhoneSheetHeading>
          <PhoneBranchSection
            featureId={featureId}
            projectId={projectId}
            branch={git.snapshot?.current_branch || worktree?.branch || null}
            worktree={worktree}
            onShowSetupDetails={() => {
              git.setPickerOpen(false);
              worktree?.onToggle();
            }}
          />
          <PhoneSheetHeading className="px-2">
            {t("workspace.git.gitActionControls.git", "Git")}
          </PhoneSheetHeading>
          {git.statusRetry.issue && (
            <PhoneGitStatusIssue issue={git.statusRetry.issue} retry={git.statusRetry} />
          )}
          <PhoneGitActionList
            featureId={featureId}
            state={git.state}
            activities={git.activities}
            onPick={(action: GitAction) => {
              // Only a dialog takes focus over; a blocked action (a toast) or
              // the PR link hands it back to "…".
              handingOffRef.current = git.runAction(action);
            }}
          />
          {showCustomActions && (
            <CustomActionsSection
              featureId={featureId}
              projectId={projectId}
              query={customActions}
              onDone={() => git.setPickerOpen(false)}
              onShowDetails={(actionId) => {
                handOff();
                useCustomActionsUiStore.getState().openMenu(featureId, actionId);
              }}
            />
          )}
        </div>
      </PhoneSheetContent>
    </Dialog>
  );
}

/** "…": its accessible name says what it flags, the dot shows it. */
function MoreSheetTrigger({ flag }: { flag: MoreFlag | null }): ReactElement {
  const { t } = useUiTranslation();
  return (
    <DialogTrigger asChild>
      <Button
        variant="ghost"
        size="icon"
        className="relative size-11 shrink-0"
        data-phone-more-trigger
        aria-label={flag ? flag.label : t("phone.header.actions", "Conversation actions")}
      >
        <EllipsisIcon className="size-5" />
        {flag && (
          <span
            aria-hidden
            className={cn(
              "absolute top-2.5 right-2.5 size-2 rounded-full ring-2 ring-background",
              flag.tone,
            )}
          />
        )}
      </Button>
    </DialogTrigger>
  );
}

/** Git status or its live updates failed: say so, and offer a retry. */
function PhoneGitStatusIssue({
  issue,
  retry,
}: {
  issue: NonNullable<GitStatusRetry["issue"]>;
  retry: GitStatusRetry;
}): ReactElement {
  const { t } = useUiTranslation();
  return (
    <div className="flex flex-col items-start gap-2 px-2 py-2">
      <p className="whitespace-pre-line break-words text-sm text-destructive" role="status">
        {t("workspace.git.status.issueWithDetail", "{{label}}. {{detail}}", issue)}
      </p>
      <Button size="sm" variant="outline" disabled={retry.pending} onClick={retry.run}>
        {retry.pending ? refreshingGitStatusLabel(t) : retryGitStatusLabel(t)}
      </Button>
    </div>
  );
}

/** The conversation's custom actions, one row each; nothing when it has none. */
function CustomActionsSection({
  featureId,
  projectId,
  query,
  onDone,
  onShowDetails,
}: {
  featureId: number;
  projectId: number;
  query: ReturnType<typeof useFeatureCustomActions>;
  onDone: () => void;
  onShowDetails: (actionId: number) => void;
}): ReactElement | null {
  const { t } = useUiTranslation();
  if (query.isSuccess && query.data.length === 0) return null;
  return (
    <>
      <PhoneSheetHeading className="px-2">
        {t("customActions.customActionsLauncher.customActions", "Custom actions")}
      </PhoneSheetHeading>
      {query.isError ? (
        <p role="alert" className="flex min-h-11 items-center px-2 text-sm text-destructive">
          {apiErrorMessage(
            query.error,
            t("phone.header.customActionsLoadFailed", "Couldn't load custom actions."),
          )}
        </p>
      ) : query.isPending ? (
        <p className="flex min-h-11 items-center gap-2 px-2 text-sm text-muted-foreground">
          <Loader2Icon className="size-4 animate-spin" />
          {t("customActions.customActionsManager.loadingActions", "Loading actions…")}
        </p>
      ) : (
        <ul className="flex flex-col">
          {query.data.map((action) => (
            <li key={action.id}>
              <CustomActionSheetRow
                action={action}
                featureId={featureId}
                projectId={projectId}
                onDone={onDone}
                onShowDetails={() => onShowDetails(action.id)}
              />
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

interface MoreFlag {
  label: string;
  tone: string;
}

/** What "…" flags: a Git run or a custom action that runs or failed. */
function moreFlag(
  git: GitActionController,
  actions: readonly CustomAction[],
  t: UiTranslator,
): MoreFlag | null {
  const gitRun = activeGitActivity(git.activities);
  const custom = aggregateRunState(actions);
  if (gitRun?.activity === "failed" || custom === "failed" || git.statusRetry.issue) {
    return {
      label: t("phone.header.actionsFailed", "Conversation actions, something failed"),
      tone: "bg-[var(--acc-red)]",
    };
  }
  if (gitRun || custom === "running") {
    return {
      label: t("phone.header.actionsRunning", "Conversation actions, something is running"),
      tone: "bg-[var(--acc-orange)]",
    };
  }
  return null;
}
