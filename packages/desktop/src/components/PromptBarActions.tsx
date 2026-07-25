import { Loader2, Pause, Send } from "lucide-react";
import { cn } from "@/lib/utils";
import { ImageAttachmentButton } from "./ImageAttachmentButton";
import { AutoMessageMenu } from "./AutoMessageMenu";

export interface PromptBarScheduleControl {
  /** Opens the conversation's schedule editor with the composer's text. */
  requestSchedule: () => void;
  disabled: boolean;
}

interface PromptBarActionsProps {
  onAddFiles: (files: FileList | File[]) => void;
  providerId?: string;
  /** `disabled || sending` — gates the attachment picker. */
  inputsDisabled: boolean;
  isRunning: boolean;
  onStop: () => void;
  onSend: () => void;
  canSend: boolean;
  sending: boolean;
  /** False when split send actions render their own buttons below the input. */
  showSendButton: boolean;
  schedule?: PromptBarScheduleControl;
}

/**
 * Trailing controls of the prompt bar: attachment picker plus the
 * stop / schedule / send buttons. Extracted from `AgentPromptBar` to keep that
 * file within the line-count budget.
 */
export function PromptBarActions({
  onAddFiles,
  providerId,
  inputsDisabled,
  isRunning,
  onStop,
  onSend,
  canSend,
  sending,
  showSendButton,
  schedule,
}: PromptBarActionsProps) {
  const showScheduleButton = !isRunning && !!schedule;
  const showActionGroup = showSendButton || showScheduleButton;

  return (
    <div className="flex shrink-0 items-center gap-1.5 self-end">
      <ImageAttachmentButton
        onFilesSelected={onAddFiles}
        disabled={inputsDisabled}
        providerId={providerId}
      />
      {isRunning && (
        <button
          type="button"
          onClick={onStop}
          aria-label="Stop agent"
          className="flex size-7 shrink-0 items-center justify-center rounded-md bg-destructive/15 text-destructive transition-colors hover:bg-destructive/25"
        >
          <Pause className="size-3.5" />
        </button>
      )}
      {showActionGroup && (
        // Send + the "auto message" chevron form a split button: Send is the
        // primary action, the chevron opens scheduling (and future auto kinds).
        <div className="inline-flex items-center">
          {showSendButton && (
            <button
              type="button"
              onClick={onSend}
              disabled={!canSend}
              aria-label="Send message"
              aria-busy={sending}
              className={cn(
                "flex h-7 w-7 shrink-0 items-center justify-center bg-primary text-primary-foreground transition-opacity hover:bg-primary/90 disabled:opacity-30",
                showScheduleButton ? "rounded-l-md rounded-r-none" : "rounded-md",
              )}
            >
              {sending ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Send className="size-3.5" />
              )}
            </button>
          )}
          {showScheduleButton && (
            <AutoMessageMenu
              requestSchedule={schedule.requestSchedule}
              disabled={schedule.disabled}
              className={cn(
                "w-5 bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground data-[state=open]:bg-primary/90 data-[state=open]:text-primary-foreground",
                showSendButton
                  ? "rounded-l-none rounded-r-md border-l border-primary-foreground/20"
                  : "rounded-md",
              )}
            />
          )}
        </div>
      )}
    </div>
  );
}
