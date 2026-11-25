import { translateUi, type UiTranslator } from "@/lib/i18n/ui";

type HistoryReadIssue = "missing" | "notFound" | "stalled" | "incomplete";
export type HistoryReadDetail = string | { issue: HistoryReadIssue };

export function historyReadText(detail: HistoryReadDetail, t: UiTranslator): string {
  if (typeof detail === "string") return detail;
  switch (detail.issue) {
    case "missing":
      return t(
        "conversation.history.missing",
        "The service didn't return this conversation's history.",
      );
    case "notFound":
      return t(
        "conversation.history.notFound",
        "The service could not find this session’s history.",
      );
    case "stalled":
      return t(
        "conversation.history.pageStalled",
        "The service returned an incomplete history page. Please retry.",
      );
    case "incomplete":
      return t("conversation.history.incomplete", "Some messages may be missing.");
  }
}

export class HistoryReadError extends Error {
  constructor(readonly issue: HistoryReadIssue) {
    super(historyReadText({ issue }, translateUi));
  }
}
