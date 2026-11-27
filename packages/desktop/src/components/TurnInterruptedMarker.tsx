import { useUiTranslation, type UiTranslator } from "@/lib/i18n/ui";
import { memo } from "react";
import { Play, Power, RotateCw, Square, TimerOff, type LucideIcon } from "lucide-react";
import { useIsLatestBlock } from "@/hooks/useIsLatestBlock";
import { CONTINUE_PROMPT } from "@/lib/agent-error-presentation";
import { formatStreamTimestamp } from "@/lib/date-utils";
import {
  COMPACTION_STOPPED_INTERRUPTION,
  QUIT_BACKGROUND_INTERRUPTION,
  QUIT_INTERRUPTION,
  RESTART_BACKGROUND_INTERRUPTION,
  RESTART_INTERRUPTION,
} from "@/lib/agent-message-origin";
import { useAgentSessionContext } from "./agent-session/agent-session-context";

type InterruptionKind = "restart" | "background" | "quit" | "quit-background" | "compact" | "user";

/** Marker content → what stopped the work; anything else is a user stop. */
const INTERRUPTION_KINDS = new Map<string, InterruptionKind>([
  [RESTART_INTERRUPTION, "restart"],
  [RESTART_BACKGROUND_INTERRUPTION, "background"],
  [QUIT_INTERRUPTION, "quit"],
  [QUIT_BACKGROUND_INTERRUPTION, "quit-background"],
  [COMPACTION_STOPPED_INTERRUPTION, "compact"],
]);

/**
 * The "Resume" prompt after a restart stopped background work: the agent's
 * turn had ended normally, so a bare "continue" would leave it waiting on
 * notifications that will never come.
 */
const BACKGROUND_STOPPED_PROMPT =
  "Cadencr restarted and stopped the background work you had left running, so you will not be notified about it. Check what it managed to do, re-run what is still needed, and continue where you left off.";
const QUIT_BACKGROUND_STOPPED_PROMPT =
  "The user quit Cadencr, which stopped the background work you had left running and cancelled any scheduled wake-up. Check what the work managed to do, re-run what is still needed, and continue where you left off.";

const INTERRUPTIONS: Record<
  InterruptionKind,
  {
    label: (t: UiTranslator) => string;
    Icon: LucideIcon;
    iconClassName: string;
    resumePrompt: string | null;
  }
> = {
  restart: {
    label: (t) =>
      t("conversation.stream.turnInterruptedMarker.restart", "Interrupted by a Cadencr restart"),
    Icon: RotateCw,
    iconClassName: "size-3",
    resumePrompt: CONTINUE_PROMPT,
  },
  background: {
    label: (t) =>
      t(
        "conversation.stream.turnInterruptedMarker.background",
        "Background tasks stopped by a Cadencr restart",
      ),
    Icon: TimerOff,
    iconClassName: "size-3",
    resumePrompt: BACKGROUND_STOPPED_PROMPT,
  },
  "quit-background": {
    label: (t) =>
      t(
        "conversation.stream.turnInterruptedMarker.quitBackground",
        "Background tasks stopped when you quit Cadencr",
      ),
    Icon: Power,
    iconClassName: "size-3",
    resumePrompt: QUIT_BACKGROUND_STOPPED_PROMPT,
  },
  quit: {
    label: (t) =>
      t("conversation.stream.turnInterruptedMarker.quit", "Stopped when you quit Cadencr"),
    Icon: Power,
    iconClassName: "size-3",
    resumePrompt: CONTINUE_PROMPT,
  },
  // A stopped compaction has no work to resume.
  compact: {
    label: (t) => t("conversation.stream.turnInterruptedMarker.compaction", "Compaction stopped"),
    Icon: Square,
    iconClassName: "size-2.5 fill-current",
    resumePrompt: null,
  },
  user: {
    label: (t) => t("conversation.stream.turnInterruptedMarker.user", "Stopped by you"),
    Icon: Square,
    iconClassName: "size-2.5 fill-current",
    resumePrompt: CONTINUE_PROMPT,
  },
};

/**
 * Where a turn was cut short — by the user, by quitting Cadencr, or by a
 * Cadencr restart (an app update, a rebuild, a
 * crash) — where a restart stopped the background work an agent had left
 * running after its turn, or where the user stopped a manual compaction
 * before it began.
 * States it in the product's words instead of the
 * provider's raw "tool use was rejected" text, and — on the turn that just
 * ended — offers to pick the work back up (a stopped compaction has no work
 * to resume). After a restart Cadencr usually
 * resumes the conversation itself, so the marker is no longer the latest block
 * and the button is not shown.
 */
export const TurnInterruptedMarker = memo(function TurnInterruptedMarker({
  blockId,
  cause,
}: {
  blockId: string;
  cause: string;
}) {
  const { t } = useUiTranslation();
  const { wsSessionId, sendPrompt } = useAgentSessionContext();
  const isLatest = useIsLatestBlock(wsSessionId, blockId);
  const kind = INTERRUPTION_KINDS.get(cause) ?? "user";
  const { label, Icon, iconClassName, resumePrompt } = INTERRUPTIONS[kind];
  return (
    <div
      data-turn-interrupted={kind}
      className="my-2 flex items-center gap-3 text-xs text-muted-foreground"
      role="note"
    >
      <span className="h-px flex-1 bg-border/70" aria-hidden />
      <span className="inline-flex items-center gap-1.5">
        <Icon className={iconClassName} aria-hidden />
        {label(t)}
      </span>
      {isLatest && resumePrompt && (
        <button
          type="button"
          onClick={() => sendPrompt(resumePrompt)}
          className="composer-instrument gap-1.5 text-foreground"
        >
          <Play className="size-3" aria-hidden />
          {t("conversation.stream.turnInterruptedMarker.resume", "Resume")}
        </button>
      )}
      <span className="h-px flex-1 bg-border/70" aria-hidden />
    </div>
  );
});

/**
 * Where Cadencr picked a conversation back up after a restart (an app update,
 * a rebuild, a crash) cut its turn off. Stands in for both the interruption
 * marker and the "continue" prompt Cadencr sent, which the agent reads but
 * the person does not need to.
 */
export const RestartResumedDivider = memo(function RestartResumedDivider({
  sentAt,
}: {
  sentAt?: string;
}) {
  const { t } = useUiTranslation();
  return (
    <div className="flex items-center gap-3 py-3" data-restart-resumed role="note">
      <div className="h-px flex-1 bg-primary/30" />
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-primary">
        <RotateCw className="size-3" aria-hidden />
        {t(
          "conversation.stream.turnInterruptedMarker.resumedAfterRestart",
          "Resumed after restart",
        )}
        {sentAt && (
          <span className="font-normal text-muted-foreground tabular-nums">
            · {formatStreamTimestamp(sentAt)}
          </span>
        )}
      </span>
      <div className="h-px flex-1 bg-primary/30" />
    </div>
  );
});
