/**
 * Plain-language framing for errors that end an agent turn. Provider-neutral:
 * it reads the backend's stable error code plus generic wording that any CLI
 * may use (rate limits, sign-in, context size), never a provider id. The raw
 * message is always kept for the details disclosure.
 */
export type AgentErrorAction = "continue" | "switchModel";

export interface AgentErrorPresentation {
  title: string;
  hint: string;
  actions: AgentErrorAction[];
}

interface Rule {
  test: (code: string, content: string) => boolean;
  presentation: AgentErrorPresentation;
}

const RULES: Rule[] = [
  {
    test: (_code, text) =>
      /overload|\b529\b|rate.?limit|\b429\b|quota|too many requests/i.test(text),
    presentation: {
      title: "The provider is overloaded or rate-limited",
      hint: "Wait a moment and continue, or switch to another model.",
      actions: ["continue", "switchModel"],
    },
  },
  {
    test: (_code, text) =>
      /not (signed|logged) in|log ?in required|unauthori[sz]ed|\b401\b|invalid api key|credential/i.test(
        text,
      ),
    presentation: {
      title: "The agent's CLI isn't signed in",
      hint: "Sign in with the provider's CLI in a terminal, then continue.",
      actions: ["continue"],
    },
  },
  {
    test: (_code, text) =>
      /context (window|length)|prompt is too long|too many tokens|maximum context|token limit/i.test(
        text,
      ),
    presentation: {
      title: "The conversation no longer fits the model's context",
      hint: "Compact the conversation, or continue with a larger-context model.",
      actions: ["switchModel"],
    },
  },
  {
    test: (code) => code === "AGENT_STOPPED",
    presentation: {
      title: "The agent process stopped unexpectedly",
      hint: "Its work so far is kept. Continue to pick up where it left off.",
      actions: ["continue"],
    },
  },
  {
    test: (code) => code === "UNKNOWN_MESSAGE",
    presentation: {
      title: "Cadencr received an event it doesn't recognize",
      hint: "The turn may be incomplete. The raw event is in the details below.",
      actions: ["continue"],
    },
  },
];

const FALLBACK: AgentErrorPresentation = {
  title: "The agent hit an error and ended its turn",
  hint: "Its work so far is kept. Continue to retry from where it stopped.",
  actions: ["continue"],
};

export function presentAgentError(
  code: string | undefined,
  content: string,
): AgentErrorPresentation {
  const normalized = code ?? "";
  return RULES.find((rule) => rule.test(normalized, content))?.presentation ?? FALLBACK;
}

/** The message sent by every "continue"/"resume" affordance. */
export const CONTINUE_PROMPT = "Continue where you left off.";
