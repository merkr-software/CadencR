import { useUiTranslation, type UiTranslator } from "@/lib/i18n/ui";
import { useEffect, useRef, type CSSProperties } from "react";
import { XIcon } from "lucide-react";
import { useReportHeight } from "./useReportHeight";
import {
  isNotchPreview,
  type NotchAgent,
  type NotchNotification,
  type NotchSnoozeMinutes,
} from "@/shared/notch";
import { IndexDotsOrb } from "./IndexDotsOrb";
import { SnoozeChips } from "./NotchSnooze";
import { NotchTile } from "./NotchTile";

const PEEK_MS: Record<NotchNotification["status"], number> = {
  completed: 6_500,
  needs_input: 10_000,
  error: 10_000,
};

/** Accent of a peek; each maps to a `--n-<tone>` color and a `.tone-<tone>` class. */
export type NotchTone = "done" | "error" | "question" | "permission";

export function peekTone(
  notification: NotchNotification,
  agent: NotchAgent | undefined,
): NotchTone {
  if (notification.status === "completed") return "done";
  if (notification.status === "error") return "error";
  return agent?.pendingKind === "question" ? "question" : "permission";
}

function statusLabel(status: NotchNotification["status"], t: UiTranslator): string {
  switch (status) {
    case "completed":
      return t("notch.peek.done", "Done");
    case "needs_input":
      return t("notch.peek.needsYou", "Needs you");
    case "error":
      return t("notch.peek.failed", "Failed");
  }
}

/**
 * Auto-dismiss that pauses while the pointer holds the peek and resumes with
 * the time that was left — in step with the CSS drain bar, which pauses too.
 * The peek is keyed by notification, so a new one starts a fresh countdown.
 */
function usePeekCountdown(totalMs: number, paused: boolean, onExpire: () => void) {
  const remaining = useRef(totalMs);
  const expire = useRef(onExpire);
  expire.current = onExpire;

  useEffect(() => {
    if (paused) return;
    const startedAt = Date.now();
    const timer = setTimeout(() => expire.current(), remaining.current);
    return () => {
      clearTimeout(timer);
      remaining.current = Math.max(0, remaining.current - (Date.now() - startedAt));
    };
  }, [paused]);
}

/** Top band of the peek, beside the cutout. */
export function PeekEars({
  notification,
  tone,
}: {
  notification: NotchNotification;
  tone: NotchTone;
}): React.JSX.Element {
  const { t } = useUiTranslation();
  return (
    <>
      <span className="ear">
        <IndexDotsOrb state={notification.status === "completed" ? "done" : "question"} />
      </span>
      <span className={`ear ear-meta tone-${tone}`}>{statusLabel(notification.status, t)}</span>
    </>
  );
}

export function NotchPeek({
  notification,
  agent,
  paused,
  tone,
  error,
  onOpen,
  onClose,
  onSnooze,
  onExpire,
  onHeight,
}: {
  notification: NotchNotification;
  agent: NotchAgent | undefined;
  paused: boolean;
  tone: NotchTone;
  error: string | null;
  onOpen: () => void;
  onClose: () => void;
  onSnooze: (minutes: NotchSnoozeMinutes) => void;
  onExpire: () => void;
  onHeight: (height: number) => void;
}): React.JSX.Element {
  const { t } = useUiTranslation();
  const ref = useRef<HTMLDivElement>(null);
  useReportHeight(ref, onHeight);
  const totalMs = PEEK_MS[notification.status];
  usePeekCountdown(totalMs, paused, onExpire);
  const meta = [agent?.projectName, agent?.providerLabel].filter(Boolean).join(" · ");
  const preview = isNotchPreview(notification);
  const title = preview
    ? t("notch.peek.previewTitle", "Your agent finished")
    : (notification.title ?? t("notch.untitledConversation", "Untitled conversation"));
  const body = preview
    ? t(
        "notch.peek.previewBody",
        "This is how a finished agent peeks out of the notch. Hover the notch anytime to see every running agent and jump straight into its conversation.",
      )
    : notification.body;
  return (
    <div
      ref={ref}
      className="peek"
      data-paused={paused}
      style={{ "--peek-ms": `${totalMs}ms` } as CSSProperties}
    >
      {/* Stretched over the whole peek; its own controls sit above it. */}
      {preview ? null : (
        <button
          type="button"
          className="peek-open"
          aria-label={t("notch.peek.open", "Open {{title}}", { title })}
          onClick={onOpen}
        />
      )}
      <NotchTile
        size="lg"
        t={t}
        agent={{
          status: notification.status === "completed" ? "done" : "question",
          pendingKind: agent?.pendingKind ?? "permission",
          providerIconSrc: agent?.providerIconSrc ?? null,
          providerIconMono: agent?.providerIconMono ?? false,
          providerLabel: agent?.providerLabel ?? null,
          unread: notification.status === "completed",
        }}
      />
      <div className="peek-head">
        <div className="peek-title">{title}</div>
        <div className="peek-meta">{meta || "Cadencr"}</div>
      </div>
      {paused ? (
        <button
          type="button"
          className="peek-close"
          aria-label={t("common.close", "Close")}
          onClick={onClose}
        >
          <XIcon strokeWidth={2.2} aria-hidden="true" />
        </button>
      ) : null}
      {body ? <p className="peek-body">{body}</p> : null}
      {paused ? <SnoozeChips onSnooze={onSnooze} /> : null}
      {error ? <div className="panel-error peek-error">{error}</div> : null}
      <span className={`peek-drain tone-${tone}`} />
    </div>
  );
}
