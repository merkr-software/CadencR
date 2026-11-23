import type { PersistedStatePayload } from "./ws-session-types";

export type { PersistedStatePayload };

export { applyPersistedState } from "./ws-session-persisted-actions";

/** Format question answers into a user-visible markdown string. */
export function formatQuestionResponse(
  pendingQuestionToolInput: Record<string, unknown>,
  response: Array<string[]>,
): string {
  const questions = Array.isArray(pendingQuestionToolInput.questions)
    ? pendingQuestionToolInput.questions
    : pendingQuestionToolInput.question != null
      ? [pendingQuestionToolInput]
      : [];
  return response
    .map((answerGroup, index) => {
      const rawQuestion = questions[index] as Record<string, unknown> | undefined;
      const question =
        typeof rawQuestion === "object" &&
        rawQuestion != null &&
        typeof rawQuestion.question === "string"
          ? (rawQuestion.question as string)
          : `Question ${index + 1}`;
      return `*${question}*\n\n**${answerGroup.join("\n")}**`;
    })
    .join("\n\n\n\n");
}
