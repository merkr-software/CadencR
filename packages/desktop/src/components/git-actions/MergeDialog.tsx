import { useState, type ReactElement } from "react";
import { AlertTriangle, GitMerge, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";

import {
  getGetWorkspaceSettingQueryKey,
  useGetWorkspaceSetting,
  useMergeFeatureBranch,
} from "@/api/generated";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { KbdShortcut } from "@/components/KbdShortcut";
import { RadioCardGroup } from "@/components/settings/RadioCardGroup";
import { GIT_MERGE_RADIO_OPTIONS } from "@/components/settings/gitMergeRadioOptions";
import {
  GIT_MERGE_MODE_KEY,
  gitMergeModeFlag,
  parseGitMergeMode,
  type GitMergeMode,
} from "@/lib/git-merge-mode";
import { apiErrorMessage } from "@/lib/api-errors";
import { selectGitStatus, useGitStatusStore } from "@/stores/useGitStatusStore";
import { useDialogSubmitShortcut } from "./useDialogSubmitShortcut";

// Hoisted to module scope so the `KbdShortcut` `keys` prop is reference-stable
// across renders — otherwise every dialog re-render would create fresh arrays
// and defeat any memoization inside the badge component.
const ESC_KEYS: string[] = ["esc"];
const SUBMIT_KEYS: string[] = ["cmd", "enter"];
// Cap on rendered conflict-file rows. A pathological merge can flag hundreds
// of files; per `frontend-performance.md` we don't render unbounded lists.
// The user only needs to see *which* files conflicted — they'll resolve them
// in the editor / git tools, not by reading this list. 50 is enough to scan.
const MAX_CONFLICT_ROWS = 50;

interface MergeDialogProps {
  featureId: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface MergeDialogBodyProps {
  currentBranch: string;
  targetBranch: string;
  effectiveMode: GitMergeMode;
  saveAsDefault: boolean;
  submitting: boolean;
  error: string | null;
  conflictFiles: string[] | null;
  onModeChange: (mode: GitMergeMode) => void;
  onSaveAsDefaultChange: (checked: boolean) => void;
  onCancel: () => void;
  onMerge: () => void;
}

function MergeDialogBody({
  currentBranch,
  targetBranch,
  effectiveMode,
  saveAsDefault,
  submitting,
  error,
  conflictFiles,
  onModeChange,
  onSaveAsDefaultChange,
  onCancel,
  onMerge,
}: MergeDialogBodyProps): ReactElement {
  return (
    <>
      <div className="space-y-4">
        <div className="rounded-md border p-3 text-sm">
          <div className="font-mono">
            {currentBranch} → {targetBranch}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Remote targets such as origin/main are merged into their local branch, e.g. main.
          </p>
        </div>

        <div className="space-y-2">
          <div className="text-sm font-medium">Merge option</div>
          <RadioCardGroup<GitMergeMode>
            ariaLabel="Merge option"
            value={effectiveMode}
            onChange={onModeChange}
            options={GIT_MERGE_RADIO_OPTIONS}
            layout="grid"
            disabled={submitting}
          />
        </div>

        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={saveAsDefault}
            onCheckedChange={(checked) => onSaveAsDefaultChange(checked === true)}
          />
          Save as default
        </label>

        {error && (
          <div
            role="alert"
            className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
          >
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
              <div className="space-y-2">
                <p className="font-medium">{error}</p>
                {conflictFiles && conflictFiles.length > 0 && (
                  <ConflictFileList files={conflictFiles} />
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      <DialogFooter>
        <Button variant="outline" onClick={onCancel} disabled={submitting}>
          Cancel
          <KbdShortcut keys={ESC_KEYS} variant="hint" />
        </Button>
        <Button onClick={onMerge} disabled={submitting}>
          {submitting && <Loader2 className="mr-2 size-4 animate-spin" />}
          Merge
          <KbdShortcut keys={SUBMIT_KEYS} variant="hint" />
        </Button>
      </DialogFooter>
    </>
  );
}

export default function MergeDialog({
  featureId,
  open,
  onOpenChange,
}: MergeDialogProps): ReactElement {
  const snapshot = useGitStatusStore(selectGitStatus(featureId));
  const setting = useGetWorkspaceSetting(GIT_MERGE_MODE_KEY, { query: { enabled: open } });
  const [mode, setMode] = useState<GitMergeMode | null>(null);
  const [saveAsDefault, setSaveAsDefault] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const merge = useMergeFeatureBranch();

  const effectiveMode = mode ?? parseGitMergeMode(setting.data?.value);
  const submitting = merge.isPending;
  const [conflictFiles, setConflictFiles] = useState<string[] | null>(null);

  async function handleMerge(): Promise<void> {
    if (submitting) return;
    setError(null);
    setConflictFiles(null);
    try {
      const result = await merge.mutateAsync({
        data: {
          feature_id: featureId,
          mode: effectiveMode,
          save_as_default: saveAsDefault,
        },
      });
      if (!result.success) {
        const files = result.conflict_files ?? [];
        setConflictFiles(files.length > 0 ? files : null);
        setError(formatMergeErrorText(result.error));
        return;
      }
      if (saveAsDefault) {
        void queryClient.invalidateQueries({
          queryKey: getGetWorkspaceSettingQueryKey(GIT_MERGE_MODE_KEY),
        });
      }
      toast.success(`Merged with ${gitMergeModeFlag(effectiveMode)}`);
      // The merge is committed, but its cleanup (e.g. switching the target
      // worktree back to its original branch) did not finish.
      if (result.warning) toast.warning(result.warning);
      onOpenChange(false);
    } catch (err) {
      setError(formatMergeError(err));
    }
  }

  useDialogSubmitShortcut({
    open,
    onSubmit: () => {
      void handleMerge();
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        // Radix's default `onOpenAutoFocus` puts focus on the first focusable
        // descendant — here, the first `RadioCardGroup` card. That focus ring
        // contradicts the *selected* card (the user's saved default may be
        // `--no-ff`, not the first option), so we suppress the initial focus
        // entirely and rely on the radio's own `selected` styling. The
        // document-level submit shortcut keeps ⌘/Ctrl+Enter available
        // immediately, even before the user clicks inside the modal.
        onOpenAutoFocus={(e) => e.preventDefault()}
        className="sm:max-w-2xl"
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitMerge className="size-5" />
            Merge branch
          </DialogTitle>
        </DialogHeader>

        <MergeDialogBody
          currentBranch={snapshot?.current_branch ?? "current"}
          targetBranch={snapshot?.target_branch ?? "target"}
          effectiveMode={effectiveMode}
          saveAsDefault={saveAsDefault}
          submitting={submitting}
          error={error}
          conflictFiles={conflictFiles}
          onModeChange={setMode}
          onSaveAsDefaultChange={setSaveAsDefault}
          onCancel={() => onOpenChange(false)}
          onMerge={() => void handleMerge()}
        />
      </DialogContent>
    </Dialog>
  );
}

function ConflictFileList({ files }: { files: string[] }): ReactElement {
  const visible = files.slice(0, MAX_CONFLICT_ROWS);
  const overflow = files.length - visible.length;
  return (
    <div>
      <p className="text-xs uppercase tracking-wide opacity-80">
        Conflicting file{files.length === 1 ? "" : "s"}
      </p>
      <ul className="mt-1 list-disc space-y-0.5 pl-5 font-mono text-xs">
        {visible.map((file) => (
          <li key={file}>{file}</li>
        ))}
      </ul>
      {overflow > 0 && (
        <p className="mt-1 text-xs opacity-80">
          + {overflow} more file{overflow === 1 ? "" : "s"}
        </p>
      )}
    </div>
  );
}

function formatMergeError(err: unknown): string {
  return formatMergeErrorText(apiErrorMessage(err, "Merge failed."));
}

// The backend returns its own structured sentences for the conflict and
// dirty-worktree cases. We only rewrite the messages that read poorly in a
// modal (the "Bad request: …" prefix) and add a generic prefix when git's
// raw error needs one. Conflict messages already start with "Merge conflict
// in …" and are passed through unchanged.
function formatMergeErrorText(message: string | null | undefined): string {
  const cleaned = message?.replace(/^Bad request:\s*/i, "").trim();
  if (!cleaned) return "Merge failed.";

  const normalized = cleaned.toLowerCase();
  if (normalized.includes("target branch worktree") && normalized.includes("uncommitted changes")) {
    return "Cannot merge because the target branch worktree has uncommitted changes. Commit, stash, or discard those changes, then try again.";
  }
  if (
    normalized.includes("source feature worktree") &&
    normalized.includes("uncommitted changes")
  ) {
    return "Cannot merge because the source feature worktree has uncommitted changes. Commit, stash, or discard those changes, then try again.";
  }
  if (normalized.startsWith("merge conflict") || normalized.startsWith("git merge ")) {
    return cleaned;
  }

  return `Merge failed: ${cleaned}`;
}
