/**
 * Build the `updated_input` payload returned to the Claude CLI for an
 * `AskUserQuestion` tool call.
 *
 * The CLI feeds `updated_input` straight back to the model as the tool result,
 * so the shape MUST match Anthropic's `AskUserQuestionOutput`:
 *
 *   {
 *     questions: [...],
 *     answers: { [questionText: string]: string }, // multi-select = comma-separated
 *     annotations?: ...
 *   }
 *
 * Sending any other shape (e.g. `string[][]`, `{ "0": "..." }`) makes the model
 * see an empty/unparseable answer block — the symptom that triggered this fix.
 *
 * See: `node_modules/@anthropic-ai/claude-agent-sdk/sdk-tools.d.ts`
 *      → `AskUserQuestionOutput`.
 */

import type { AgentQuestionAnswers } from "@/types/agent-question";

/** Extract the ordered list of question texts from the tool's original input. */
function extractQuestionLabels(toolInput: Record<string, unknown>): string[] {
  const list = toolInput.questions;
  if (Array.isArray(list)) {
    return list.map((q) => {
      if (typeof q === "object" && q !== null) {
        const text = (q as Record<string, unknown>).question;
        if (typeof text === "string") return text;
      }
      return "";
    });
  }
  if (typeof toolInput.question === "string") return [toolInput.question];
  return [];
}

/**
 * Convert the drawer's `string[][]` response (one inner array per question
 * holding stable option ids when available, labels otherwise, and/or free-text "Other") into the
 * `updated_input` payload the CLI expects.
 */
export function buildAskUserQuestionUpdatedInput(
  toolInput: Record<string, unknown>,
  response: AgentQuestionAnswers,
): Record<string, unknown> {
  const labels = extractQuestionLabels(toolInput);
  const answers: Record<string, string> = {};
  response.forEach((selected, index) => {
    const key = labels[index] && labels[index].length > 0 ? labels[index] : `Question ${index + 1}`;
    answers[key] = answerLabels(toolInput, index, selected).join(", ");
  });
  const structuredAnswers = buildStructuredAnswers(toolInput, response);
  return {
    ...toolInput,
    answers,
    ...(structuredAnswers ? { structured_answers: structuredAnswers } : {}),
  };
}

function answerLabels(
  toolInput: Record<string, unknown>,
  questionIndex: number,
  selected: string[],
): string[] {
  if (!Array.isArray(toolInput.questions)) return selected;
  const rawQuestion = toolInput.questions[questionIndex];
  if (typeof rawQuestion !== "object" || rawQuestion === null) return selected;
  const options = Array.isArray((rawQuestion as Record<string, unknown>).options)
    ? ((rawQuestion as Record<string, unknown>).options as unknown[])
    : [];
  return selected.map((value) => {
    const option = options.find(
      (rawOption) =>
        typeof rawOption === "object" &&
        rawOption !== null &&
        (rawOption as Record<string, unknown>).id === value,
    );
    if (typeof option !== "object" || option === null) return value;
    const label = (option as Record<string, unknown>).label;
    return typeof label === "string" ? label : value;
  });
}

function buildStructuredAnswers(
  toolInput: Record<string, unknown>,
  response: AgentQuestionAnswers,
): Array<{ questionId: string; selectedOptionIds: string[] }> | undefined {
  if (!Array.isArray(toolInput.questions)) return undefined;
  const answers = toolInput.questions.flatMap((rawQuestion, index) => {
    if (typeof rawQuestion !== "object" || rawQuestion === null) return [];
    const question = rawQuestion as Record<string, unknown>;
    if (typeof question.id !== "string") return [];
    const options = Array.isArray(question.options) ? question.options : [];
    const optionIds = new Map<string, string>();
    const knownIds = new Set<string>();
    for (const rawOption of options) {
      if (typeof rawOption !== "object" || rawOption === null) continue;
      const option = rawOption as Record<string, unknown>;
      if (typeof option.label === "string" && typeof option.id === "string") {
        optionIds.set(option.label, option.id);
        knownIds.add(option.id);
      }
    }
    return [
      {
        questionId: question.id,
        selectedOptionIds: (response[index] ?? []).flatMap((value) => {
          const id = knownIds.has(value) ? value : optionIds.get(value);
          return id ? [id] : [];
        }),
      },
    ];
  });
  return answers.length > 0 ? answers : undefined;
}
