import { useUiTranslation, translateUi } from "@/lib/i18n/ui";
import { Files, Loader2Icon } from "lucide-react";
import { useMemo, type ReactElement, type RefObject } from "react";

import type { UncommittedFile } from "@/api/generated";
import { KbdShortcut } from "@/components/KbdShortcut";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { apiErrorMessage } from "@/lib/api-errors";
import { StashFileList } from "./StashFileList";

const ESC_KEYS = ["esc"];
const SUBMIT_KEYS = ["cmd", "enter"];
const STASH_NAME_INPUT_ID = "stash-changes-name";

export interface StashDialogViewModel {
  name: string;
  includeUntracked: boolean;
  error: string | null;
  blockedReason: string | null;
  pending: boolean;
  canSubmit: boolean;
  handleNameChange: (name: string) => void;
  handleToggleUntracked: () => void;
}

interface StashChangesDialogBodyProps {
  submission: StashDialogViewModel;
  files: UncommittedFile[];
  loading: boolean;
  error: unknown;
  nameInputRef: RefObject<HTMLInputElement | null>;
  onOpenChange: (open: boolean) => void;
}

export function StashChangesDialogBody({
  submission,
  files,
  loading,
  error,
  nameInputRef,
  onOpenChange,
}: StashChangesDialogBodyProps): ReactElement {
  const includedFileCount = useMemo(
    () =>
      files.reduce(
        (count, file) =>
          count + (file.status !== "untracked" || submission.includeUntracked ? 1 : 0),
        0,
      ),
    [files, submission.includeUntracked],
  );
  return (
    <>
      <div className="grid min-h-0 gap-4 px-6 py-5">
        <IncludeUntrackedOption submission={submission} />
        <StashNameField submission={submission} nameInputRef={nameInputRef} />
        <StashFiles
          files={files}
          includedFileCount={includedFileCount}
          includeUntracked={submission.includeUntracked}
          loading={loading}
          error={error}
        />
        <StashDialogFeedback submission={submission} />
      </div>
      <StashChangesDialogFooter submission={submission} onOpenChange={onOpenChange} />
    </>
  );
}

function IncludeUntrackedOption({
  submission,
}: {
  submission: StashDialogViewModel;
}): ReactElement {
  const { t } = useUiTranslation();
  return (
    <div className="flex items-start gap-3 rounded-lg border border-border bg-card px-3 py-3 shadow-xs transition-colors hover:bg-accent/30">
      <Checkbox
        id="stash-include-untracked"
        className="mt-0.5"
        checked={submission.includeUntracked}
        onCheckedChange={submission.handleToggleUntracked}
        disabled={submission.pending}
        aria-describedby="stash-include-untracked-description"
      />
      <div className="flex min-w-0 flex-1 items-start justify-between gap-4">
        <span className="grid gap-0.5">
          <label
            htmlFor="stash-include-untracked"
            className="cursor-pointer text-sm font-medium text-foreground"
          >
            {t(
              "workspace.git.stashChangesDialogBody.includeUntrackedFiles",
              "Include untracked files",
            )}
          </label>
          <span id="stash-include-untracked-description" className="text-xs text-muted-foreground">
            {t(
              "workspace.git.stashChangesDialogBody.addNewFilesThatGitIsNot",
              "Add new files that Git is not tracking yet.",
            )}
          </span>
        </span>
        <span aria-hidden="true" className="shrink-0 text-muted-foreground">
          <KbdShortcut keys={["u"]} variant="hint" />
        </span>
      </div>
    </div>
  );
}

function StashNameField({
  submission,
  nameInputRef,
}: {
  submission: StashDialogViewModel;
  nameInputRef: RefObject<HTMLInputElement | null>;
}): ReactElement {
  const { t } = useUiTranslation();
  const describedBy = submission.error
    ? "stash-changes-name-help stash-changes-error"
    : "stash-changes-name-help";
  return (
    <div className="grid gap-2">
      <div className="flex items-center justify-between gap-3">
        <label htmlFor={STASH_NAME_INPUT_ID} className="text-sm font-medium">
          {t("workspace.git.stashChangesDialogBody.name", "Name")}{" "}
          <span className="font-normal text-muted-foreground">
            {t("workspace.git.stashChangesDialogBody.optional", "(optional)")}
          </span>
        </label>
        <span aria-hidden="true" className="text-muted-foreground">
          <KbdShortcut keys={["n"]} variant="hint" />
        </span>
      </div>
      <Input
        ref={nameInputRef}
        id={STASH_NAME_INPUT_ID}
        value={submission.name}
        onChange={(event) => submission.handleNameChange(event.target.value)}
        placeholder={t(
          "workspace.git.stashChangesDialogBody.useGitSDefaultDescription",
          "Use Git’s default description",
        )}
        disabled={submission.pending}
        className="bg-card"
        aria-invalid={submission.error ? true : undefined}
        aria-describedby={describedBy}
      />
      <p id="stash-changes-name-help" className="text-xs text-muted-foreground">
        {t(
          "workspace.git.stashChangesDialogBody.leaveBlankToLetGitDescribeThe",
          "Leave blank to let Git describe the stash automatically.",
        )}
      </p>
    </div>
  );
}

function StashFiles({
  files,
  includedFileCount,
  includeUntracked,
  loading,
  error,
}: {
  files: UncommittedFile[];
  includedFileCount: number;
  includeUntracked: boolean;
  loading: boolean;
  error: unknown;
}): ReactElement {
  const { t } = useUiTranslation();
  const summary = loading
    ? "Loading…"
    : error
      ? "Unavailable"
      : `${includedFileCount} of ${files.length} included`;
  return (
    <section className="min-h-0 overflow-hidden rounded-lg border border-border bg-card shadow-xs">
      <header className="flex items-center justify-between gap-3 border-b border-border/70 bg-muted/20 px-3 py-2.5">
        <span className="flex items-center gap-2 text-sm font-medium text-foreground">
          <Files aria-hidden="true" className="size-3.5 text-muted-foreground" />
          {t("workspace.git.stashChangesDialogBody.changesToStash", "Changes to stash")}
        </span>
        <span className="text-xs tabular-nums text-muted-foreground">{summary}</span>
      </header>
      <div className="p-3">
        {loading ? (
          <div role="status" className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
            <Loader2Icon className="size-4 animate-spin" />
            {t("workspace.git.stashChangesDialogBody.loadingChanges", "Loading changes…")}
          </div>
        ) : error ? (
          <p role="alert" className="text-sm text-destructive">
            {apiErrorMessage(
              error,
              translateUi(
                "workspace.git.stashChangesDialogBody.failedToLoadUncommittedFiles",
                "Failed to load uncommitted files.",
              ),
            )}
          </p>
        ) : (
          <StashFileList files={files} includeUntracked={includeUntracked} />
        )}
      </div>
    </section>
  );
}

function StashDialogFeedback({
  submission,
}: {
  submission: StashDialogViewModel;
}): ReactElement | null {
  if (submission.error) {
    return (
      <p
        id="stash-changes-error"
        role="alert"
        className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
      >
        {submission.error}
      </p>
    );
  }
  if (!submission.blockedReason) return null;
  return (
    <p
      role="status"
      className="rounded-md border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground"
    >
      {submission.blockedReason}
    </p>
  );
}

function StashChangesDialogFooter({
  submission,
  onOpenChange,
}: {
  submission: StashDialogViewModel;
  onOpenChange: (open: boolean) => void;
}): ReactElement {
  const { t } = useUiTranslation();
  return (
    <DialogFooter className="border-t border-border/70 bg-muted/20 px-6 py-4">
      <Button
        type="button"
        variant="outline"
        onClick={() => onOpenChange(false)}
        disabled={submission.pending}
      >
        {t("workspace.git.stashChangesDialogBody.cancel", "Cancel")}
        <span aria-hidden="true">
          <KbdShortcut keys={ESC_KEYS} variant="hint" />
        </span>
      </Button>
      <Button type="submit" disabled={!submission.canSubmit}>
        {submission.pending ? <Loader2Icon className="size-4 animate-spin" /> : null}
        {submission.pending
          ? t("workspace.git.stashChangesDialogBody.stashing", "Stashing…")
          : t("workspace.git.stashChangesDialogBody.stashChanges", "Stash changes")}
        {!submission.pending ? (
          <span aria-hidden="true">
            <KbdShortcut keys={SUBMIT_KEYS} variant="hint" />
          </span>
        ) : null}
      </Button>
    </DialogFooter>
  );
}
