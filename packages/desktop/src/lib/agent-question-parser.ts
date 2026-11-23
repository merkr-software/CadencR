import type { AgentQuestion, AgentQuestionOption } from "@/types/agent-question";

/**
 * Parse AskUserQuestion tool calls from stream-json events.
 * Extracts questions from content_block_start events with tool_use type
 * where the tool name is "AskUserQuestion".
 */
/** Normalize options array: handle both string[] and {label, description}[] formats */
function normalizeOptions(raw: unknown): AgentQuestionOption[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw.map((item: unknown) => {
    if (typeof item === "string") return { label: item };
    if (typeof item === "object" && item !== null) {
      const obj = item as Record<string, unknown>;
      return {
        id: typeof obj.id === "string" ? obj.id : undefined,
        label: (obj.label as string) ?? "",
        description: typeof obj.description === "string" ? obj.description : undefined,
        preview: typeof obj.preview === "string" ? obj.preview : undefined,
      };
    }
    return { label: String(item) };
  });
}

function parseQuestion(input: Record<string, unknown>): AgentQuestion {
  return {
    question: typeof input.question === "string" ? input.question : "",
    options: normalizeOptions(input.options),
    ...(input.allowCustomAnswer === false && { allowCustomAnswer: false }),
    multiSelect: input.multiSelect === true || input.multiple === true,
  };
}

export function parseAskUserQuestions(toolInput: Record<string, unknown>): AgentQuestion[] {
  if (Array.isArray(toolInput.questions)) {
    return toolInput.questions
      .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
      .map(parseQuestion);
  }
  return typeof toolInput.question === "string" ? [parseQuestion(toolInput)] : [];
}
