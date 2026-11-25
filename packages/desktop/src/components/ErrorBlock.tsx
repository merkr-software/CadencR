import { useUiTranslation } from "@/lib/i18n/ui";
/**
 * Inline error message rendered in the agent conversation stream.
 *
 * Surfaces backend `session.error` envelopes (any provider) as a distinct
 * block — separate from plain text + `isError` flag — so the user can clearly
 * tell apart a real error from agent output. Provider-neutral: every error
 * that flows through the conversation goes through this component.
 *
 * It leads with what happened in plain words and what to do next (Continue,
 * Switch model) on the turn that just ended; the raw message and its code stay
 * one click away for diagnosis.
 */
import { memo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { AlertTriangleIcon, ChevronRight, Play, Repeat, Settings } from "lucide-react";
import { CopyButton } from "@/components/CopyButton";
import { useIsLatestBlock } from "@/hooks/useIsLatestBlock";
import { CONTINUE_PROMPT, presentAgentError } from "@/lib/agent-error-presentation";
import { cn } from "@/lib/utils";
import { transcriptErrorDisplayText } from "@/lib/client-transcript-errors";
import { useAgentSessionContext } from "./agent-session/agent-session-context";

interface ErrorBlockProps {
  content: string;
  /** Optional machine-readable code from the backend (e.g. "SDK_ERROR"). */
  code?: string;
  /** Block id, to offer recovery only on the turn that just ended. */
  blockId?: string;
}

export const ErrorBlock = memo(function ErrorBlock({ content, code, blockId }: ErrorBlockProps) {
  // A failed hidden tool (no block of its own) is not a turn-ending error:
  // show its message as is.
  if (!blockId) return <InlineError content={content} code={code} />;
  return <TurnError content={content} code={code} blockId={blockId} />;
});

function InlineError({ content, code }: ErrorBlockProps) {
  const { t } = useUiTranslation();
  const displayText = transcriptErrorDisplayText(content, code, t);
  return (
    <div
      role="alert"
      className="my-1 flex gap-2 rounded-md border border-[var(--acc-red)]/40 bg-[var(--acc-red)]/8 px-3 py-2 text-xs"
    >
      <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0 text-[var(--acc-red)]" />
      <p className="min-w-0 flex-1 whitespace-pre-wrap break-words text-foreground/90">
        {displayText}
      </p>
      <CopyButton
        text={displayText}
        label={t("conversation.stream.errorBlock.copyError", "Copy error")}
        className="h-fit self-start p-1"
      />
    </div>
  );
}

function TurnError({ content, code, blockId }: ErrorBlockProps & { blockId: string }) {
  const { t } = useUiTranslation();
  const presentation = presentAgentError(code, content, t);
  const displayText = transcriptErrorDisplayText(content, code, t);
  const { wsSessionId, sendPrompt, openModelPicker } = useAgentSessionContext();
  const isLatest = useIsLatestBlock(wsSessionId, blockId);
  const [open, setOpen] = useState(false);
  const showActions = isLatest;
  return (
    <div
      role="alert"
      className="my-1 flex gap-2.5 rounded-md border border-[var(--acc-red)]/40 bg-[var(--acc-red)]/8 px-3 py-2.5 text-xs"
    >
      <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0 text-[var(--acc-red)]" />
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-medium text-foreground">{presentation.title}</p>
        <p className="mt-0.5 text-muted-foreground">{presentation.hint}</p>
        {presentation.showCause && (
          <p className="mt-1.5 whitespace-pre-wrap break-words font-mono text-[11px] text-foreground/90">
            {displayText}
          </p>
        )}
        {showActions && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {presentation.actions.includes("continue") && (
              <button
                type="button"
                className="composer-instrument gap-1.5 bg-muted/60 text-foreground"
                onClick={() => sendPrompt(CONTINUE_PROMPT)}
              >
                <Play className="size-3" aria-hidden />
                {t("common.continue", "Continue")}
              </button>
            )}
            {presentation.actions.includes("switchModel") && (
              <button
                type="button"
                className="composer-instrument gap-1.5 text-foreground"
                onClick={openModelPicker}
              >
                <Repeat className="size-3" aria-hidden />
                {t("conversation.stream.errorBlock.switchModel", "Switch model")}
              </button>
            )}
            {presentation.actions.includes("openSettings") && (
              <Link to="/settings" className="composer-instrument gap-1.5 text-foreground">
                <Settings className="size-3" aria-hidden />
                {t("conversation.stream.errorBlock.openSettings", "Open Settings")}
              </Link>
            )}
          </div>
        )}
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className="mt-2 inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
        >
          <ChevronRight className={cn("size-3 transition-transform", open && "rotate-90")} />
          {t("conversation.stream.errorBlock.details", "Details")}
          {code ? ` · ${code}` : ""}
        </button>
        {open && (
          <p className="mt-1 whitespace-pre-wrap break-words font-mono text-[11px] text-foreground/80">
            {displayText}
          </p>
        )}
      </div>
      <CopyButton
        text={displayText}
        label={t("conversation.stream.errorBlock.copyError", "Copy error")}
        className="h-fit self-start p-1"
      />
    </div>
  );
}
