import type { UiTranslator } from "@/lib/i18n/ui";

export const CLIENT_TRANSCRIPT_ERRORS = {
  MALFORMED_TRANSCRIPT_BLOCK: {
    key: "conversation.history.invalidLiveBlock",
    message:
      "A transcript line could not be displayed because its live event was malformed. Reconnect to reload the conversation.",
  },
  MALFORMED_USER_MESSAGE: {
    key: "conversation.history.invalidStoredMessage",
    message:
      "A persisted user message could not be displayed because its live event was malformed. Reconnect to reload the canonical transcript.",
  },
  MALFORMED_MESSAGE: {
    key: "conversation.stream.invalidUpdate",
    message:
      "A streamed update from the agent was malformed and could not be displayed. The transcript above may be incomplete.",
  },
  UNPARSEABLE_ENVELOPE: {
    key: "conversation.stream.unreadable",
    message:
      "A streamed update from the agent was unreadable and could not be displayed. The transcript above may be incomplete.",
  },
} as const;

export function transcriptErrorDisplayText(
  content: string,
  code: string | undefined,
  t: UiTranslator,
): string {
  if (!code || !Object.hasOwn(CLIENT_TRANSCRIPT_ERRORS, code)) return content;
  const { key, message } = CLIENT_TRANSCRIPT_ERRORS[code as keyof typeof CLIENT_TRANSCRIPT_ERRORS];
  // Provider text is diagnostic data even if the provider reuses a client code.
  return content === message ? t(key, message) : content;
}
