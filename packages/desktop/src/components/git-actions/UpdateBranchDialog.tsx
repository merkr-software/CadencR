import { UiTrans, useUiTranslation, translateUi, type UiTranslator } from "@/lib/i18n/ui";
import { useEffect, useRef, useState, type ReactElement } from "react";
import { AlertTriangle, ArrowRight, Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";

import {
  useUpdateBranch,
  type GitStatusSnapshot,
  type UpdateBranchStrategy,
} from "@/api/generated";
import { KeyboardOnlyShortcutHint } from "@/components/KbdShortcut";
import { RadioCardGroup, type RadioCardOption } from "@/components/settings/RadioCardGroup";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { apiErrorMessage } from "@/lib/api-errors";
import { describeGitUpdateConflictFiles } from "./gitUpdateMessages";
import { resolveGitUpdateSource, type GitUpdateSource } from "./useGitAction";
import { useDialogSubmitShortcut } from "./useDialogSubmitShortcut";
import { gitUpdateMutationKey } from "./useGitUpdatePending";

const ESC_KEYS: string[] = ["esc"];
const SUBMIT_KEYS: string[] = ["cmd", "enter"];

function strategyOptions(t: UiTranslator): readonly RadioCardOption<UpdateBranchStrategy>[] {
  return [
    {
      value: "rebase",
      label: t("workspace.git.updateBranchDialog.rebase", "Rebase"),
      description: t(
        "workspace.git.updateBranchDialog.replayTheCurrentBranchSCommitsOn",
        "Replay the current branch's commits on the selected update source.",
      ),
    },
    {
      value: "merge",
      label: t("workspace.git.updateBranchDialog.merge", "Merge"),
      description: t(
        "workspace.git.updateBranchDialog.mergeTheSelectedUpdateSourceIntoThe",
        "Merge the selected update source into the current branch.",
      ),
    },
  ];
}

interface UpdateBranchDialogProps {
  featureId: number;
  open: boolean;
  snapshot: GitStatusSnapshot;
  disabledReason: string | null;
  onOpenChange: (open: boolean) => void;
}

export default function UpdateBranchDialog({
  featureId,
  open,
  snapshot,
  disabledReason,
  onOpenChange,
}: UpdateBranchDialogProps): ReactElement {
  const { t } = useUiTranslation();
  const [strategy, setStrategy] = useState<UpdateBranchStrategy>("rebase");
  const [error, setError] = useState<{ rawMessage: string } | null>(null);
  const update = useUpdateBranch({
    mutation: { mutationKey: gitUpdateMutationKey(featureId) },
  });
  const submitting = update.isPending;
  const source = resolveGitUpdateSource(snapshot);

  async function handleUpdate(): Promise<void> {
    if (submitting || disabledReason) return;
    setError(null);
    try {
      const result = await update.mutateAsync({
        data: { feature_id: featureId, strategy },
      });
      if (result.outcome === "conflicts") {
        toast.warning(
          translateUi(
            "workspace.git.updateBranchDialog.updatePausedForConflicts",
            "Update paused for conflicts",
          ),
          {
            description: describeGitUpdateConflictFiles(result.conflict_files),
          },
        );
        onOpenChange(false);
        return;
      }
      notifyBranchUpdated(snapshot.current_branch, source.branch);
      onOpenChange(false);
    } catch (caught) {
      setError({ rawMessage: apiErrorMessage(caught, "") });
    }
  }

  useDialogSubmitShortcut({
    open,
    enabled: !submitting && disabledReason === null,
    onSubmit: () => void handleUpdate(),
  });

  const handleOpenChange = (next: boolean): void => {
    if (submitting && !next) return;
    onOpenChange(next);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        showCloseButton={!submitting}
        className="grid-rows-[auto_minmax(0,1fr)_auto] sm:max-w-xl"
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <RefreshCw className="size-5" />
            {t("workspace.git.updateBranchDialog.updateCurrentBranch", "Update current branch")}
          </DialogTitle>
        </DialogHeader>

        <DialogBody className="space-y-4">
          <BranchDirection currentBranch={snapshot.current_branch} source={source} />
          <DivergenceCounts source={source} />

          <div className="space-y-2">
            <div className="text-sm font-medium">
              {t("workspace.git.updateBranchDialog.updateStrategy", "Update strategy")}
            </div>
            <RadioCardGroup<UpdateBranchStrategy>
              ariaLabel={t("workspace.git.updateBranchDialog.updateStrategy", "Update strategy")}
              value={strategy}
              onChange={setStrategy}
              options={strategyOptions(t)}
              layout="grid"
              disabled={submitting || disabledReason !== null}
            />
          </div>

          {error && <UpdateFailure rawMessage={error.rawMessage} />}
          {!submitting && disabledReason && <UpdateError message={disabledReason} />}
        </DialogBody>

        <UpdateBranchFooter
          disabledReason={disabledReason}
          submitting={submitting}
          onCancel={() => onOpenChange(false)}
          onSubmit={() => void handleUpdate()}
        />
      </DialogContent>
    </Dialog>
  );
}

function BranchDirection({
  currentBranch,
  source,
}: {
  currentBranch: string;
  source: GitUpdateSource;
}): ReactElement {
  const { t } = useUiTranslation();
  return (
    <div className="rounded-md border border-border bg-card p-3">
      <div className="flex min-w-0 items-center gap-2 font-mono text-sm">
        <code className="truncate" title={source.branch}>
          {source.branch}
        </code>
        <ArrowRight
          className="size-4 shrink-0 text-muted-foreground"
          aria-label={t("workspace.git.updateBranchDialog.updates", "updates")}
        />
        <code className="truncate" title={currentBranch}>
          {currentBranch}
        </code>
      </div>
      <p className="mt-1 text-xs text-muted-foreground wrap-anywhere">
        {source.kind === "target" ? (
          <UiTrans
            i18nKey="workspace.git.updateBranchDialog.exactTarget"
            defaults="Exact target ref: <ref>{{branch}}</ref>"
            values={{ branch: source.branch }}
            components={{ ref: <code /> }}
          />
        ) : (
          <UiTrans
            i18nKey="workspace.git.updateBranchDialog.exactUpstream"
            defaults="Exact upstream ref: <ref>{{branch}}</ref>"
            values={{ branch: source.branch }}
            components={{ ref: <code /> }}
          />
        )}
      </p>
    </div>
  );
}

function DivergenceCounts({ source }: { source: GitUpdateSource }): ReactElement {
  const { t } = useUiTranslation();
  return (
    <dl className="grid grid-cols-2 gap-3 text-sm">
      <div className="rounded-md border border-border p-3">
        <dt className="text-xs text-muted-foreground">
          {source.kind === "target"
            ? t("workspace.git.updateBranchDialog.behindTarget", "Behind target")
            : t("workspace.git.updateBranchDialog.behindUpstream", "Behind upstream")}
        </dt>
        <dd className="mt-1 font-mono text-base">{source.behind}</dd>
      </div>
      <div className="rounded-md border border-border p-3">
        <dt className="text-xs text-muted-foreground">
          {source.kind === "target"
            ? t("workspace.git.updateBranchDialog.aheadTarget", "Ahead of target")
            : t("workspace.git.updateBranchDialog.aheadUpstream", "Ahead of upstream")}
        </dt>
        <dd className="mt-1 font-mono text-base">{source.ahead}</dd>
      </div>
    </dl>
  );
}

function UpdateError({
  message,
  reveal = false,
}: {
  message: string;
  /** Scroll into view: a failed update lands below the cards, off a phone screen. */
  reveal?: boolean;
}): ReactElement {
  const alertRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (reveal) alertRef.current?.scrollIntoView({ block: "nearest" });
  }, [reveal]);

  return (
    <div
      ref={alertRef}
      role="alert"
      className="flex gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
    >
      <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
      <p className="min-w-0 whitespace-pre-wrap wrap-anywhere">{message}</p>
    </div>
  );
}

function UpdateBranchFooter({
  disabledReason,
  submitting,
  onCancel,
  onSubmit,
}: {
  disabledReason: string | null;
  submitting: boolean;
  onCancel: () => void;
  onSubmit: () => void;
}): ReactElement {
  const { t } = useUiTranslation();
  return (
    <DialogFooter>
      <Button variant="outline" onClick={onCancel} disabled={submitting}>
        {t("workspace.git.updateBranchDialog.cancel", "Cancel")}
        <KeyboardOnlyShortcutHint keys={ESC_KEYS} />
      </Button>
      <Button
        onClick={onSubmit}
        disabled={submitting || disabledReason !== null}
        title={
          disabledReason ??
          t("workspace.git.updateBranchDialog.updateCurrentBranch", "Update current branch")
        }
      >
        {submitting && <Loader2 className="mr-2 size-4 animate-spin" />}
        {submitting
          ? t("workspace.git.updateBranchDialog.updating", "Updating…")
          : t("workspace.git.updateBranchDialog.updateBranch", "Update branch")}
        <KeyboardOnlyShortcutHint keys={SUBMIT_KEYS} />
      </Button>
    </DialogFooter>
  );
}

function notifyBranchUpdated(branch: string, source: string): void {
  toast.success(
    translateUi(
      "workspace.git.updateBranchDialog.updatedBranchFromSource",
      "Updated {{branch}} from {{source}}",
      { branch, source },
    ),
  );
}

function UpdateFailure({ rawMessage }: { rawMessage: string }): ReactElement {
  const { t } = useUiTranslation();
  const message =
    rawMessage ||
    t(
      "workspace.git.updateBranchDialog.couldNotUpdateTheCurrentBranch",
      "Could not update the current branch.",
    );
  return <UpdateError message={message} reveal />;
}
