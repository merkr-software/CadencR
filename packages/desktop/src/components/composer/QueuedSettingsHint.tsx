import { useUiTranslation, translateUi, type UiTranslator } from "@/lib/i18n/ui";
import { memo, type ReactElement } from "react";
import { Loader2 } from "lucide-react";
import { capitalize } from "@/lib/utils";
import { useWsSessionStore } from "@/stores/ws-session-store";
import { FAST_MODE_COMMAND_KINDS } from "@/stores/ws-session-commands";

const NO_ACTIONS: readonly string[] = [];

const modelName = (t: UiTranslator) => t("conversation.composer.queuedSettingsHint.model", "model");
const effortName = (t: UiTranslator) =>
  t("conversation.composer.queuedSettingsHint.thinkingEffort", "thinking effort");

/** What each replayable session setting is called in the read-out. */
const SETTING_NAMES: Readonly<Record<string, (t: UiTranslator) => string>> = {
  "provider.set": (t: UiTranslator) =>
    t("conversation.composer.queuedSettingsHint.provider", "provider"),
  "model.set": modelName,
  "effort.set": effortName,
  "profile.set": (t: UiTranslator) =>
    t("conversation.composer.queuedSettingsHint.profile", "profile"),
  "mode.set": (t: UiTranslator) =>
    t("conversation.composer.queuedSettingsHint.permissionMode", "permission mode"),
  "access_mode.set": (t: UiTranslator) =>
    t("conversation.composer.queuedSettingsHint.accessMode", "access mode"),
  "runtime_overrides.set:model": modelName,
  "runtime_overrides.set:thinking_effort": effortName,
  ...Object.fromEntries(
    FAST_MODE_COMMAND_KINDS.map((kind) => [
      kind,
      (t: UiTranslator) => t("conversation.composer.queuedSettingsHint.fastMode", "fast mode"),
    ]),
  ),
};

/** "Model change waits…" / "Model and permission mode changes wait…"; null when nothing waits. */
export function queuedSettingsMessage(
  actions: readonly string[],
  t: UiTranslator = translateUi,
  language = "en-GB",
): string | null {
  const names = [
    ...new Set(
      actions.map(
        (action) =>
          SETTING_NAMES[action]?.(t) ??
          t("conversation.composer.queuedSettingsHint.setting", "setting"),
      ),
    ),
  ];
  if (names.length === 0) return null;
  const list =
    names.length === 1
      ? names[0]
      : new Intl.ListFormat(language === "en" ? "en-GB" : language, { type: "conjunction" }).format(
          names,
        );
  const subject = capitalize(list);
  if (!subject) return null;
  return t("conversation.composer.queuedSettingsHint.changesWaiting", {
    count: names.length,
    subject,
    defaultValue_one: "{{subject}} change waits for the backend to reconnect.",
    defaultValue_other: "{{subject}} changes wait for the backend to reconnect.",
  });
}

/**
 * A setting changed while the backend was unreachable waits to be sent. The
 * controls keep showing the confirmed value (no optimistic update); this
 * read-out says the change is pending until the reconnect sends it. It takes
 * the session id as a prop, not from the composer context, which changes
 * while the agent streams.
 */
export const QueuedSettingsHint = memo(function QueuedSettingsHint({
  wsSessionId,
}: {
  wsSessionId: string | undefined;
}): ReactElement | null {
  const { t, i18n } = useUiTranslation();
  const actions = useWsSessionStore((s) =>
    wsSessionId == null
      ? NO_ACTIONS
      : (s.sessions[wsSessionId]?.queuedCommandActions ?? NO_ACTIONS),
  );
  const message = queuedSettingsMessage(actions, t, i18n.language);
  if (message === null) return null;
  return (
    <span
      role="status"
      title={message}
      className="composer-instrument gap-1.5 text-muted-foreground"
    >
      <Loader2 className="size-3.5 animate-spin" aria-hidden />
      <span className="@max-[34rem]:hidden">
        {t("conversation.composer.queuedSettingsHint.waitingToApply", "Waiting to apply")}
      </span>
      <span className="sr-only">{message}</span>
    </span>
  );
});
