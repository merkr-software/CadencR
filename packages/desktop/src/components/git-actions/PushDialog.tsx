import { useUiTranslation, translateUi, type UiTranslator } from "@/lib/i18n/ui";
/**
 * Push dialog: picks a force mode, then streams `git push` through a
 * backend PTY and surfaces a passphrase / yes-no input whenever ssh
 * prompts.
 *
 * Why a dialog at all (the original push was a fire-and-forget mutation):
 *  - SSH-protected keys produce a real prompt the user has to answer.
 *    Without a UI surface the push hangs invisibly until the PTY's
 *    stdin times out — terrible failure mode.
 *  - Even on the happy path, seeing live `git push` output (delta
 *    compression, byte counts, `remote: …` messages) is useful
 *    transparency.
 *  - Force pushes are destructive, so the mode has to be an explicit,
 *    visible choice rather than a hidden modifier.
 *
 * Like commit, the run itself lives in `usePushSubmission` one level up:
 * closing this dialog backgrounds the push instead of abandoning it, and
 * reopening remounts a view over the same streaming state.
 *
 * Per `error-handling.md`, stderr surfaces inline in the terminal pane
 * (no silent swallow). Per `no-optimistic-updates.md`, we don't
 * pre-invalidate after success — the WS `git.status` envelope drives
 * everything downstream.
 */
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactElement,
  type RefObject,
} from "react";
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
import { Input } from "@/components/ui/input";
import { KbdShortcut } from "@/components/KbdShortcut";
import { PushForceMode, usePushInput } from "@/api/generated";
import { selectPushOutput, usePushOutputStore } from "@/stores/usePushOutputStore";
import { detectSshPrompt } from "./detectSshPrompt";
import { PushOutputPane } from "./PushOutputPane";
import { PushForceSelector } from "./PushForceSelector";
import { toastError } from "@/lib/api-errors";
import { usePushDialogShortcuts } from "./usePushDialogShortcuts";
import type { PushSubmissionController } from "./usePushSubmission";

// Hoisted so the `keys` prop is reference-stable across re-renders (streaming
// buffer chunks re-render this dialog frequently).
const ESC_KEYS: string[] = ["esc"];
const SUBMIT_KEYS: string[] = ["cmd", "enter"];

function pushSubmitLabel(force: PushForceMode, failed: boolean, t: UiTranslator): string {
  switch (force) {
    case PushForceMode.none:
      return failed
        ? t("workspace.git.pushDialog.retryPush", "Retry — push")
        : t("workspace.git.pushDialog.push", "Push");
    case PushForceMode["force-with-lease"]:
      return failed
        ? t("workspace.git.pushDialog.retryForcepushwithlease", "Retry — force push (with lease)")
        : t("workspace.git.pushDialog.forcePushWithLease", "Force push (with lease)");
    case PushForceMode.force:
      return failed
        ? t("workspace.git.pushDialog.retryForcepush", "Retry — force push")
        : t("workspace.git.pushDialog.forcePush", "Force push");
  }
}

interface PushDialogProps {
  featureId: number;
  open: boolean;
  submission: PushSubmissionController;
}

export default function PushDialog({ featureId, open, submission }: PushDialogProps): ReactElement {
  const { t } = useUiTranslation();
  const {
    outcome,
    submitting,
    submit,
    onDialogOpenChange,
    force,
    setForce,
    answeredOffset,
    markPromptAnswered,
  } = submission;
  const failed = outcome === "error";

  const handleSubmit = useCallback((): void => {
    if (submitting) return;
    void submit(force);
  }, [force, submit, submitting]);

  const handleSubmitShortcut = useCallback((): void => {
    // Mirrors commit: Cmd/Ctrl+Enter starts the push, and once it is
    // running the same chord sends it to the background.
    if (submitting) onDialogOpenChange(false);
    else handleSubmit();
  }, [handleSubmit, onDialogOpenChange, submitting]);

  usePushDialogShortcuts({
    open,
    // While ssh is prompting, the mnemonics would eat the passphrase.
    mnemonicsEnabled: !submitting,
    onModeChange: setForce,
    onSubmitShortcut: handleSubmitShortcut,
  });

  return (
    <Dialog open={open} onOpenChange={onDialogOpenChange}>
      <DialogContent
        // Radix would otherwise focus the first mode card, painting a ring
        // that reads as a second "selected" state next to the radio dot.
        // Same suppression as `MergeDialog` — the mnemonics and ⌘/Ctrl+Enter
        // are document-level, so nothing needs seeded focus.
        onOpenAutoFocus={(event) => event.preventDefault()}
        // Same width as `CommitDialog`: git's progress lines need the room.
        className="!w-[min(90vw,48rem)] !max-w-[min(90vw,48rem)] sm:!max-w-[min(90vw,48rem)]"
      >
        <DialogHeader>
          <DialogTitle>
            {submitting
              ? t("workspace.git.pushDialog.pushingToRemote", "Pushing to remote")
              : failed
                ? t("workspace.git.pushDialog.pushFailed", "Push failed")
                : t("workspace.git.pushDialog.pushToRemote", "Push to remote")}
          </DialogTitle>
          {submitting && (
            <DialogDescription>
              {t(
                "workspace.git.pushDialog.youCanKeepThisOpenOrContinue",
                "You can keep this open or continue in the background.",
              )}
            </DialogDescription>
          )}
          {failed && (
            <DialogDescription>
              {t(
                "workspace.git.pushDialog.reviewTheOutputThenRetryPossibly",
                "Review the output, then retry — possibly with a different push mode.",
              )}
            </DialogDescription>
          )}
        </DialogHeader>

        <div className="min-w-0 space-y-3">
          {!submitting && <PushForceSelector value={force} onChange={setForce} />}
          <PushOutputPane featureId={featureId} isMutationPending={submitting} hasFailed={failed} />
          <PushPromptSection
            featureId={featureId}
            answeredOffset={answeredOffset}
            onAnswered={markPromptAnswered}
          />
        </div>

        <PushFooter
          submitting={submitting}
          failed={failed}
          force={force}
          onSubmit={handleSubmit}
          onClose={() => onDialogOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}

function useActivePushPrompt(
  buffer: string,
  answeredOffset: number,
  inputRef: RefObject<HTMLInputElement | null>,
): ReturnType<typeof detectSshPrompt> {
  const activePrompt = useMemo(() => {
    const detected = detectSshPrompt(buffer);
    return detected && detected.offset > answeredOffset ? detected : null;
  }, [answeredOffset, buffer]);
  useEffect(() => {
    if (activePrompt) inputRef.current?.focus();
  }, [activePrompt, inputRef]);
  return activePrompt;
}

interface PushPromptSectionProps {
  featureId: number;
  answeredOffset: number;
  onAnswered: (offset: number) => void;
}

/**
 * Owns the buffer subscription so a chunk arriving every few milliseconds
 * re-renders only the prompt, not the dialog frame, the mode picker and the
 * footer around it (`PushOutputPane` subscribes independently).
 */
const PushPromptSection = memo(function PushPromptSection({
  featureId,
  answeredOffset,
  onAnswered,
}: PushPromptSectionProps): ReactElement | null {
  const { t } = useUiTranslation();
  const buffer = usePushOutputStore(selectPushOutput(featureId));
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const sendInput = usePushInput();
  const activePrompt = useActivePushPrompt(buffer, answeredOffset, inputRef);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!activePrompt) return;
    const offset = activePrompt.offset;
    // Don't mark the prompt as answered until the POST resolves — if the
    // call throws (network drop, backend rejected the input) we want the
    // input to stay visible so the user can retry. The Send button
    // disables itself via `sendInput.isPending`, which prevents double
    // submits while the request is inflight.
    try {
      await sendInput.mutateAsync({ data: { feature_id: featureId, text: value } });
      onAnswered(offset);
      setValue("");
    } catch (err) {
      // Do NOT fail the run here — the push itself is still running and
      // may yet succeed. A toast explains the partial failure without
      // polluting the terminal pane, and the prompt stays visible with
      // the typed value preserved for retry.
      toastError(
        err,
        translateUi("workspace.git.pushDialog.failedToSendInput", "Failed to send input."),
      );
    }
  }

  if (!activePrompt) return null;

  return (
    <form onSubmit={handleSubmit} className="space-y-1.5">
      <label htmlFor="push-prompt-input" className="block font-mono text-xs text-muted-foreground">
        {activePrompt.text}
      </label>
      <div className="flex gap-2">
        <Input
          id="push-prompt-input"
          ref={inputRef}
          type={activePrompt.kind === "password" ? "password" : "text"}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          autoComplete="off"
          data-1p-ignore
          spellCheck={false}
          disabled={sendInput.isPending}
        />
        <Button type="submit" disabled={sendInput.isPending}>
          {sendInput.isPending && <Loader2 className="mr-2 size-3.5 animate-spin" />}
          {t("workspace.git.pushDialog.send", "Send")}
        </Button>
      </div>
    </form>
  );
});

interface PushFooterProps {
  submitting: boolean;
  failed: boolean;
  force: PushForceMode;
  onSubmit: () => void;
  onClose: () => void;
}

function PushFooter({
  submitting,
  failed,
  force,
  onSubmit,
  onClose,
}: PushFooterProps): ReactElement {
  const { t } = useUiTranslation();
  if (submitting) {
    return (
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          <Minimize2 className="mr-2 size-4" />
          {t("workspace.git.pushDialog.runInBackground", "Run in background")}
          <KbdShortcut keys={SUBMIT_KEYS} variant="hint" />
        </Button>
      </DialogFooter>
    );
  }

  return (
    <DialogFooter>
      <Button variant="outline" onClick={onClose}>
        {t("workspace.git.pushDialog.close", "Close")}
        <KbdShortcut keys={ESC_KEYS} variant="hint" />
      </Button>
      <Button
        variant={force === PushForceMode.force ? "destructive" : "default"}
        onClick={onSubmit}
      >
        {pushSubmitLabel(force, failed, t)}
        <KbdShortcut keys={SUBMIT_KEYS} variant="hint" />
      </Button>
    </DialogFooter>
  );
}
