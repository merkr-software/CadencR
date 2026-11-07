import { CornerDownRight, ListPlus, Loader2, Send, Square } from "lucide-react";
import { cn } from "@/lib/utils";
import { ImageAttachmentButton } from "./ImageAttachmentButton";
import { AutoMessageMenu } from "./AutoMessageMenu";
import { useShortcutKeys } from "@/hooks/useShortcutLabel";
import { ShortcutTooltip } from "./ShortcutTooltip";

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
  /** A Stop was sent and the backend has not answered yet. */
  stopping?: boolean;
  onSend: () => void;
  canSend: boolean;
  sending: boolean;
  /** False when split send actions render their own buttons below the input. */
  showSendButton: boolean;
  schedule?: PromptBarScheduleControl;
  /** Queue the draft for after the turn; present only while the agent works. */
  onQueue?: () => void;
  /** The provider can't take mid-turn prompts: the main button queues. */
  queuesOnEnter?: boolean;
}

const PRIMARY =
  "flex h-(--composer-instrument-size) shrink-0 items-center justify-center gap-1.5 bg-primary text-primary-foreground transition-[background-color,opacity] hover:bg-primary/90 disabled:opacity-30";

/**
 * Trailing run controls of the composer's instrument row.
 *
 * Idle: Send, with a chevron for scheduling. While the agent works the same
 * button becomes **Steer** (the draft reaches the running turn at its next
 * step), the chevron adds "Queue after this turn", and a labelled **Stop**
 * sits beside it — a square, never the pause glyph, because stopping ends the
 * turn rather than suspending it.
 */
export function PromptBarActions({
  onAddFiles,
  providerId,
  inputsDisabled,
  isRunning,
  onStop,
  stopping = false,
  onSend,
  canSend,
  sending,
  showSendButton,
  schedule,
  onQueue,
  queuesOnEnter = false,
}: PromptBarActionsProps) {
  // Stop is the binding pressed twice.
  const stopKeys = useShortcutKeys("agent-stop");
  const showMenu = !!schedule || !!onQueue;
  const showActionGroup = showSendButton || showMenu;

  return (
    <div className="flex shrink-0 items-center gap-1.5 self-end">
      <ImageAttachmentButton
        onFilesSelected={onAddFiles}
        disabled={inputsDisabled}
        providerId={providerId}
      />
      {isRunning && (
        <ShortcutTooltip label="Stop the agent" keys={[...stopKeys, ...stopKeys]}>
          <button
            type="button"
            data-composer-action
            onClick={onStop}
            disabled={stopping}
            aria-busy={stopping}
            aria-label={stopping ? "Stopping agent" : "Stop agent"}
            className="flex h-(--composer-instrument-size) shrink-0 items-center gap-1.5 rounded-md bg-destructive/12 px-2 text-[12px] font-medium text-destructive transition-colors hover:bg-destructive/22 disabled:opacity-60"
          >
            {stopping ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Square className="size-3.5 fill-current" />
            )}
            <span className="@max-[30rem]:hidden">{stopping ? "Stopping…" : "Stop"}</span>
          </button>
        </ShortcutTooltip>
      )}
      {showActionGroup && (
        <div className="inline-flex items-center">
          {showSendButton && (
            <button
              type="button"
              data-composer-action
              onClick={queuesOnEnter && onQueue ? onQueue : onSend}
              disabled={!canSend}
              aria-label={runLabel(isRunning, queuesOnEnter)}
              aria-busy={sending}
              title={runTitle(isRunning, queuesOnEnter)}
              className={cn(
                PRIMARY,
                isRunning ? "px-2 text-[12px] font-medium" : "w-(--composer-instrument-size)",
                showMenu ? "rounded-l-md rounded-r-none" : "rounded-md",
              )}
            >
              {sending ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : isRunning ? (
                <>
                  {queuesOnEnter ? (
                    <ListPlus className="size-3.5" />
                  ) : (
                    <CornerDownRight className="size-3.5" />
                  )}
                  <span className="@max-[30rem]:hidden">{queuesOnEnter ? "Queue" : "Steer"}</span>
                </>
              ) : (
                <Send className="size-3.5" />
              )}
            </button>
          )}
          {showMenu && (
            <AutoMessageMenu
              requestSchedule={schedule?.requestSchedule}
              scheduleDisabled={schedule?.disabled ?? true}
              onQueue={onQueue}
              disabled={(!schedule || schedule.disabled) && !onQueue}
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

function runLabel(isRunning: boolean, queuesOnEnter: boolean): string {
  if (!isRunning) return "Send message";
  return queuesOnEnter
    ? "Queue this message for after the turn"
    : "Steer the agent with this message";
}

function runTitle(isRunning: boolean, queuesOnEnter: boolean): string | undefined {
  if (!isRunning) return undefined;
  return queuesOnEnter
    ? "This agent can't take messages mid-turn: it gets this one when the turn ends (Enter)"
    : "Steer: the agent reads it at its next step (Enter)";
}
