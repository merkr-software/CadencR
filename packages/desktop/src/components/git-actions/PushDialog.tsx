/**
 * Push dialog: streams `git push -u origin HEAD` through a backend PTY
 * and surfaces a passphrase / yes-no input whenever ssh prompts.
 *
 * Why a dialog at all (the previous push was a fire-and-forget mutation):
 *  - SSH-protected keys produce a real prompt the user has to answer.
 *    Without a UI surface the push hangs invisibly until the PTY's
 *    stdin times out — terrible failure mode.
 *  - Even on the happy path, seeing live `git push` output (delta
 *    compression, byte counts, `remote: …` messages) is useful
 *    transparency. The dialog auto-closes on success in ~milliseconds
 *    when nothing prompts.
 *
 * Per `error-handling.md`, stderr surfaces inline in the terminal pane
 * (no silent swallow). Per `no-optimistic-updates.md`, we don't
 * pre-invalidate after success — the WS `git.status` envelope drives
 * everything downstream.
 */
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactElement } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { KbdShortcut } from "@/components/KbdShortcut";
import { usePush, usePushInput } from "@/api/generated";
import {
  selectPushOutput,
  selectPushRunning,
  usePushOutputStore,
} from "@/stores/usePushOutputStore";
import { detectSshPrompt } from "./detectSshPrompt";
import { PushOutputPane } from "./PushOutputPane";
import { apiErrorMessage, toastError } from "@/lib/api-errors";
import { useDialogSubmitShortcut } from "./useDialogSubmitShortcut";

// Hoisted so the `keys` prop is reference-stable across re-renders (streaming
// buffer chunks re-render this dialog frequently).
const ESC_KEYS: string[] = ["esc"];

interface PushDialogProps {
  featureId: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export default function PushDialog({
  featureId,
  open,
  onOpenChange,
}: PushDialogProps): ReactElement {
  const [failed, setFailed] = useState(false);
  // Offset of the last prompt the user has already answered. Compared to
  // `detectSshPrompt`'s output: a NEW prompt at a strictly larger offset
  // re-shows the input. Storing offsets (rather than a boolean "answered")
  // is what lets us tell apart "same prompt still on screen" from "ssh is
  // asking another question further down".
  const [answeredOffset, setAnsweredOffset] = useState<number>(-1);
  const [inputValue, setInputValue] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Buffer + lifecycle from the streaming store (narrow selectors so this
  // dialog re-renders only on its feature's chunks).
  const buffer = usePushOutputStore(selectPushOutput(featureId));
  const wsRunning = usePushOutputStore(selectPushRunning(featureId));

  const push = usePush();
  const sendInput = usePushInput();
  const submitting = push.isPending || wsRunning;

  // Auto-start on open: we already required one click to get here from
  // GitActionButton, so a second confirm in the dialog would be friction
  // for zero benefit. The "running" state takes over the footer button.
  // `pushStartedRef` makes this single-fire across StrictMode double-mount.
  const pushStartedRef = useRef(false);
  useEffect(() => {
    if (!open) return;
    if (pushStartedRef.current) return;
    pushStartedRef.current = true;
    setFailed(false);
    setAnsweredOffset(-1);
    const store = usePushOutputStore.getState();
    store.reset(featureId);
    store.start(featureId);
    void runPush();
    // We deliberately depend only on `open`. Re-running on featureId
    // change isn't a real case (dialog is keyed on featureId from the
    // parent) and would re-trigger the push on prop changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Wipe state when the dialog closes so reopening doesn't show the
  // previous run's terminal. Same pattern as CommitDialog.
  useEffect(() => {
    if (open) return;
    pushStartedRef.current = false;
    setFailed(false);
    setAnsweredOffset(-1);
    setInputValue("");
    usePushOutputStore.getState().reset(featureId);
  }, [open, featureId]);

  // Decide whether to show the prompt input. A prompt is "active" when
  // the buffer's tail matches a known prompt regex AND its offset is
  // strictly past anything we've already answered.
  const activePrompt = useMemo(() => {
    const detected = detectSshPrompt(buffer);
    if (!detected) return null;
    if (detected.offset <= answeredOffset) return null;
    return detected;
  }, [buffer, answeredOffset]);

  // Focus the input the moment a prompt appears — the user shouldn't
  // have to click into the textbox to start typing their passphrase.
  useEffect(() => {
    if (activePrompt) inputRef.current?.focus();
  }, [activePrompt]);

  async function runPush(): Promise<void> {
    try {
      const result = await push.mutateAsync({
        data: { feature_id: featureId },
      });
      if (!result.success) {
        showError(result.error ?? "Push failed.");
        return;
      }
      toast.success("Pushed");
      onOpenChange(false);
    } catch (err) {
      showError(apiErrorMessage(err, "Push failed."));
    }
  }

  /**
   * Surface an error inside the terminal frame. If the WS pipeline
   * already streamed lines (the typical case — ssh stderr, git error),
   * we just append the final summary so the user sees both the live log
   * *and* a clear failure footer. If nothing streamed (sync HTTP error,
   * network drop), we synthesize a minimal "session" so the frame still
   * has something to show.
   */
  function showError(detail: string): void {
    usePushOutputStore.getState().fail(featureId, detail);
    setFailed(true);
  }

  async function handlePromptSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (!activePrompt) return;
    const text = inputValue;
    const offset = activePrompt.offset;
    // Don't mark the prompt as answered until the POST resolves — if the
    // call throws (network drop, backend rejected the input) we want the
    // input to stay visible so the user can retry. The Send button
    // disables itself via `sendInput.isPending`, which prevents double
    // submits while the request is inflight.
    try {
      await sendInput.mutateAsync({
        data: { feature_id: featureId, text },
      });
      // Success: hide the input and clear the typed value. Backend
      // acknowledged the answer, no retry needed.
      setAnsweredOffset(offset);
      setInputValue("");
    } catch (err) {
      // Do NOT call showError here — the push itself is still running and
      // may yet succeed (e.g. agent answered the same prompt). A toast
      // explains the partial failure without polluting the terminal pane.
      // Leave `answeredOffset` and `inputValue` untouched so the prompt
      // stays visible with the typed value preserved for retry.
      toastError(err, "Failed to send input.");
    }
  }

  // Cmd/Ctrl+Enter closes the dialog when push is finished — same shortcut
  // convention as commit. During a running push we unregister the shortcut so
  // it doesn't fight the prompt input's own Enter.
  useDialogSubmitShortcut({
    open,
    enabled: !submitting,
    onSubmit: () => onOpenChange(false),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="!w-[min(90vw,48rem)] !max-w-[min(90vw,48rem)] sm:!max-w-[min(90vw,48rem)]">
        <DialogHeader>
          <DialogTitle>Push to remote</DialogTitle>
        </DialogHeader>

        <div className="space-y-3 min-w-0">
          <PushOutputPane
            featureId={featureId}
            isMutationPending={push.isPending}
            hasFailed={failed}
          />

          {activePrompt && (
            <form onSubmit={handlePromptSubmit} className="space-y-1.5">
              <label
                htmlFor="push-prompt-input"
                className="block text-xs font-mono text-muted-foreground"
              >
                {activePrompt.text}
              </label>
              <div className="flex gap-2">
                <Input
                  id="push-prompt-input"
                  ref={inputRef}
                  type={activePrompt.kind === "password" ? "password" : "text"}
                  value={inputValue}
                  onChange={(e) => setInputValue(e.target.value)}
                  // `autoComplete="off"` and `data-1p-ignore` ask password
                  // managers (1Password, Bitwarden, browser built-ins) NOT
                  // to capture this — the user is typing an SSH key
                  // passphrase, not a website credential, and a save-prompt
                  // here would be both annoying and wrong.
                  autoComplete="off"
                  data-1p-ignore
                  spellCheck={false}
                  disabled={sendInput.isPending}
                />
                <Button type="submit" disabled={sendInput.isPending}>
                  {sendInput.isPending && <Loader2 className="size-3.5 animate-spin mr-2" />}
                  Send
                </Button>
              </div>
            </form>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
            // Spell out *why* Cancel is disabled while running: closing the
            // dialog mid-push wouldn't actually cancel the backend work,
            // and pretending it did would be the kind of UX lie we keep
            // off-limits.
            title={submitting ? "Push is running — wait for it to finish." : "Close this dialog"}
          >
            {submitting ? "Running…" : "Close"}
            {/* Render unconditionally: even while submitting and the button is
                disabled, Radix Dialog's Escape handler still closes the dialog,
                so the hint stays accurate. */}
            <KbdShortcut keys={ESC_KEYS} variant="hint" />
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
