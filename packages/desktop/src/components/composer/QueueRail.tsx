import { useUiTranslation } from "@/lib/i18n/ui";
import { memo, useState, type ReactElement } from "react";
import { Textarea } from "@/components/ui/textarea";
import { AlertCircle, ArrowUp, ListOrdered, Loader2, Pencil, X } from "lucide-react";
import type { QueuedPrompt } from "@/api/generated";
import { AgentMessageSender } from "@/components/AgentMessageSender";
import { cn } from "@/lib/utils";
import { useComposerContext } from "./ComposerContext";
import {
  STACK_ROW_CLASS,
  StackList,
  StackRowActions,
  StackRowButton,
  StackSection,
} from "./ComposerStack";
import { usePromptQueue, type PromptQueueApi } from "./usePromptQueue";

/**
 * Messages queued for after the agent's current turn, stacked on top of the
 * composer card. The server delivers the oldest one when the turn ends; until
 * then each can be sent right away (it steers the running turn), edited or
 * removed. Messages other conversations' agents queued for this one
 * (`delivery=next_turn`) follow the user's own, under their sender, and stay
 * theirs once edited. A failed delivery stays here with its reason — nothing
 * queued is ever dropped silently.
 */
export const QueueRail = memo(function QueueRail(): ReactElement | null {
  const { t } = useUiTranslation();
  const { sessionId, isRunning } = useComposerContext();
  const queue = usePromptQueue(sessionId);
  if (queue.items.length === 0) return null;
  return (
    <StackSection
      tone="queue"
      label={t("conversation.composer.queueRail.queuedMessages", "Queued messages")}
      data-composer-queue
      icon={<ListOrdered />}
      title={t("conversation.composer.queueRail.queued", "Queued")}
      count={queue.items.length}
      hint={
        isRunning
          ? t(
              "conversation.composer.queueRail.sendsWhenTheAgentFinishesThisTurn",
              "Sends when the agent finishes this turn",
            )
          : t(
              "conversation.composer.queueRail.heldSendsAfterTheNextTurnOr",
              "Held: sends after the next turn, or send it now",
            )
      }
      summary={<QueueSummary items={queue.items} />}
    >
      <StackList>
        {queue.items.map((item, index) => (
          <QueueRow key={item.id} item={item} index={index} queue={queue} />
        ))}
      </StackList>
    </StackSection>
  );
});

/** The next message to go out, and whether any failed to. */
function QueueSummary({ items }: { items: readonly QueuedPrompt[] }): ReactElement {
  const { t } = useUiTranslation();
  const failed = items.filter((item) => item.status === "error").length;
  return (
    <>
      {/* First: the line truncates its end. */}
      {failed > 0 && (
        <span className="text-destructive">
          {t("conversation.composer.queueRail.failedCount", "{{count}} not delivered ·", {
            count: failed,
          })}{" "}
        </span>
      )}
      {t("conversation.composer.queueRail.next", "Next: {{message}}", {
        message: items[0]?.content,
      })}
    </>
  );
}

function QueueRow({
  item,
  index,
  queue,
}: {
  item: QueuedPrompt;
  index: number;
  queue: PromptQueueApi;
}): ReactElement {
  const { t } = useUiTranslation();
  const [editing, setEditing] = useState(false);
  const delivering = item.status === "delivering";
  const failed = item.status === "error";
  if (editing) {
    return <QueueRowEditor item={item} queue={queue} onDone={() => setEditing(false)} />;
  }
  return (
    <li className={cn(STACK_ROW_CLASS, failed && "ring-1 ring-destructive/40")}>
      <span className="w-4 shrink-0 text-center font-mono text-[11px] text-muted-foreground">
        {delivering ? (
          <Loader2
            className="mx-auto size-3 animate-spin"
            aria-label={t("conversation.composer.queueRail.sending", "Sending")}
          />
        ) : (
          index + 1
        )}
      </span>
      <span className="min-w-0 flex-1">
        {item.origin && <AgentMessageSender origin={item.origin} />}
        <span className="block truncate" title={item.content}>
          {item.content}
        </span>
        {failed && (
          <span className="flex items-center gap-1 text-xs text-destructive">
            <AlertCircle className="size-3 shrink-0" />
            {t(
              "conversation.composer.queueRail.deliveryFailure",
              "Not delivered: {{error}}. Edit or send it again.",
              {
                error:
                  item.error ?? t("conversation.composer.queueRail.unknownError", "unknown error"),
              },
            )}
          </span>
        )}
      </span>
      {!delivering && (
        <StackRowActions>
          <StackRowButton
            label={t("conversation.composer.queueRail.sendNow", "Send now")}
            onClick={() => void queue.sendNow(item.id)}
            disabled={queue.busy}
          >
            <ArrowUp className="size-3.5" />
          </StackRowButton>
          <StackRowButton
            label={t("conversation.composer.queueRail.edit", "Edit")}
            onClick={() => setEditing(true)}
          >
            <Pencil className="size-3.5" />
          </StackRowButton>
          <StackRowButton
            label={t("conversation.composer.queueRail.remove", "Remove")}
            onClick={() => void queue.remove(item.id)}
            disabled={queue.busy}
          >
            <X className="size-3.5" />
          </StackRowButton>
        </StackRowActions>
      )}
    </li>
  );
}

function QueueRowEditor({
  item,
  queue,
  onDone,
}: {
  item: QueuedPrompt;
  queue: PromptQueueApi;
  onDone: () => void;
}): ReactElement {
  const { t } = useUiTranslation();
  const [value, setValue] = useState(item.content);
  const save = (): void => {
    const next = value.trim();
    if (!next) return;
    // A refusal is toasted by the hook; the editor stays open with the text.
    void queue.update(item.id, next).then((saved) => saved && onDone());
  };
  return (
    <li className="flex flex-col gap-1.5 rounded-md bg-background/80 p-1.5">
      <Textarea
        autoFocus
        aria-label={t("conversation.composer.queueRail.editQueuedMessage", "Edit queued message")}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            save();
          } else if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onDone();
          }
        }}
        rows={Math.min(6, Math.max(2, value.split("\n").length))}
        className="min-h-0 resize-none px-2 py-1.5 text-[13px] shadow-none md:text-[13px]"
      />
      <span className="flex items-center justify-end gap-1.5 text-xs">
        <button
          type="button"
          className="composer-instrument text-muted-foreground"
          onClick={onDone}
        >
          {t("conversation.composer.queueRail.cancel", "Cancel")}
        </button>
        <button
          type="button"
          className="composer-instrument bg-primary/15 text-primary"
          onClick={save}
          disabled={queue.busy || value.trim().length === 0}
        >
          {t("conversation.composer.queueRail.save", "Save")}
        </button>
      </span>
    </li>
  );
}
