/** A single selectable option within an AskUserQuestion question */
export interface AgentQuestionOption {
  id?: string;
  label: string;
  description?: string;
  preview?: string;
}

/** A single question from an AskUserQuestion tool call */
export interface AgentQuestion {
  /** The question text */
  question: string;
  /** Pre-defined options the user can choose from */
  options?: AgentQuestionOption[];
  /** Whether multiple options can be selected */
  multiSelect?: boolean;
}

export type AgentQuestionAnswers = string[][];

export function agentQuestionOptionValue(option: AgentQuestionOption): string {
  return option.id ?? option.label;
}
