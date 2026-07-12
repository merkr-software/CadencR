import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { Loader2, Minimize2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { KbdShortcut } from "@/components/KbdShortcut";
import { type UncommittedFile, useGetUncommittedFiles } from "@/api/generated";
import { CommitOutputPane } from "./CommitOutputPane";
import { UncommittedFileList } from "./UncommittedFileList";
import { apiErrorMessage } from "@/lib/api-errors";
import { useDialogSubmitShortcut } from "./useDialogSubmitShortcut";
import type { CommitSubmissionController } from "./useCommitSubmission";

const ESC_KEYS: string[] = ["esc"];
const SUBMIT_KEYS: string[] = ["cmd", "enter"];

interface CommitDialogProps {
  featureId: number;
  open: boolean;
  submission: CommitSubmissionController;
}

interface CommitFieldsProps {
  message: string;
  selected: Set<string>;
  files: UncommittedFile[];
  loading: boolean;
  error: unknown;
  onMessageChange: (message: string) => void;
  onToggle: (path: string) => void;
}

function CommitFields({
  message,
  selected,
  files,
  loading,
  error,
  onMessageChange,
  onToggle,
}: CommitFieldsProps): ReactElement {
  return (
    <div className="space-y-3">
      <Textarea
        value={message}
        onChange={(event) => onMessageChange(event.target.value)}
        placeholder="Commit message"
        rows={3}
        autoFocus
      />
      {loading ? (
        <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          <span>Loading changes…</span>
        </div>
      ) : error ? (
        <p className="text-sm text-destructive">
          {apiErrorMessage(error, "Failed to load uncommitted files.")}
        </p>
      ) : (
        <UncommittedFileList files={files} selected={selected} onToggle={onToggle} />
      )}
    </div>
  );
}

function useCommitSelection(
  open: boolean,
  files: UncommittedFile[],
  loading: boolean,
): [Set<string>, (path: string) => void] {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const firstLoadDoneRef = useRef(false);
  const seenPathsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!open) {
      setSelected((previous) => (previous.size === 0 ? previous : new Set()));
      firstLoadDoneRef.current = false;
      seenPathsRef.current = new Set();
      return;
    }
    if (loading) return;
    const paths = new Set(files.map((file) => file.path));
    if (!firstLoadDoneRef.current) {
      firstLoadDoneRef.current = true;
      seenPathsRef.current = new Set(paths);
      setSelected(paths);
      return;
    }
    const seen = seenPathsRef.current;
    setSelected((previous) => {
      const next = new Set<string>();
      for (const path of previous) if (paths.has(path)) next.add(path);
      for (const path of paths) if (!seen.has(path)) next.add(path);
      if (next.size === previous.size && [...next].every((path) => previous.has(path))) {
        return previous;
      }
      return next;
    });
    for (const path of paths) seen.add(path);
  }, [files, loading, open]);

  const toggle = useCallback((path: string): void => {
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  return useMemo(() => [selected, toggle], [selected, toggle]);
}

export default function CommitDialog({
  featureId,
  open,
  submission,
}: CommitDialogProps): ReactElement {
  const [message, setMessage] = useState("");
  const { outcome, submitting, submit, onDialogOpenChange } = submission;
  const filesQuery = useGetUncommittedFiles(
    { feature_id: featureId },
    { query: { enabled: open && !submitting } },
  );
  const files = useMemo(() => filesQuery.data ?? [], [filesQuery.data]);
  const [selected, toggle] = useCommitSelection(open && !submitting, files, filesQuery.isLoading);
  const failed = outcome === "error";
  const canSubmit =
    message.trim().length > 0 && selected.size > 0 && !submitting && !filesQuery.isLoading;

  useEffect(() => {
    if (!open) setMessage("");
  }, [open]);

  const handleSubmit = useCallback((): void => {
    if (!canSubmit) return;
    void submit({
      feature_id: featureId,
      message: message.trim(),
      file_paths: Array.from(selected),
    });
  }, [canSubmit, featureId, message, selected, submit]);

  const handleSubmitShortcut = useCallback((): void => {
    if (submitting) onDialogOpenChange(false);
    else handleSubmit();
  }, [handleSubmit, onDialogOpenChange, submitting]);

  useDialogSubmitShortcut({ open, onSubmit: handleSubmitShortcut });

  return (
    <Dialog open={open} onOpenChange={onDialogOpenChange}>
      <DialogContent className="!w-[min(90vw,48rem)] !max-w-[min(90vw,48rem)] sm:!max-w-[min(90vw,48rem)]">
        <DialogHeader>
          <DialogTitle>
            {submitting ? "Committing changes" : failed ? "Commit failed" : "Commit changes"}
          </DialogTitle>
          {submitting && (
            <DialogDescription>
              Pre-commit hooks are running. You can keep this open or continue in the background.
            </DialogDescription>
          )}
          {failed && (
            <DialogDescription>
              Review the output, fix the problem, then update the message or selection and retry.
            </DialogDescription>
          )}
        </DialogHeader>

        <div className="min-w-0 space-y-3">
          {(submitting || failed) && <CommitOutputPane featureId={featureId} />}
          {!submitting && (
            <CommitFields
              message={message}
              selected={selected}
              files={files}
              loading={filesQuery.isLoading}
              error={filesQuery.isError ? filesQuery.error : null}
              onMessageChange={setMessage}
              onToggle={toggle}
            />
          )}
        </div>

        <CommitFooter
          submitting={submitting}
          failed={failed}
          canSubmit={canSubmit}
          onSubmit={handleSubmit}
          onClose={() => onDialogOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}

interface CommitFooterProps {
  submitting: boolean;
  failed: boolean;
  canSubmit: boolean;
  onSubmit: () => void;
  onClose: () => void;
}

function CommitFooter({
  submitting,
  failed,
  canSubmit,
  onSubmit,
  onClose,
}: CommitFooterProps): ReactElement {
  if (submitting) {
    return (
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          <Minimize2 className="mr-2 size-4" />
          Run in background
          <KbdShortcut keys={SUBMIT_KEYS} variant="hint" />
        </Button>
      </DialogFooter>
    );
  }
  return (
    <DialogFooter>
      <Button variant="outline" onClick={onClose}>
        Close
        <KbdShortcut keys={ESC_KEYS} variant="hint" />
      </Button>
      <Button onClick={onSubmit} disabled={!canSubmit}>
        {failed ? "Retry commit" : "Commit"}
        <KbdShortcut keys={SUBMIT_KEYS} variant="hint" />
      </Button>
    </DialogFooter>
  );
}
