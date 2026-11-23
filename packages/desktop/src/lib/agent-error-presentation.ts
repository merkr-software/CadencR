/**
 * Plain-language framing for errors that end an agent turn. Provider-neutral:
 * it reads the backend's stable error code plus generic wording that any CLI
 * may use (rate limits, sign-in, context size), never a provider id. The raw
 * message is always kept for the details disclosure.
 *
 * A code the backend already classified wins over the wording: a rejected
 * request's message can quote anything (Codex lists every method it knows,
 * `account/rateLimits/read` included), so it must never read as an overload.
 */
import { SETTINGS_READ_FAILED } from "@/lib/api-errors";

export type AgentErrorAction = "continue" | "switchModel" | "openSettings";

export interface AgentErrorPresentation {
  title: string;
  hint: string;
  actions: AgentErrorAction[];
  /** Show the raw message up front: it is the cause the user acts on. */
  showCause?: boolean;
}

interface Rule {
  test: (code: string, content: string) => boolean;
  presentation: AgentErrorPresentation;
}

/** Failures the backend classified; their message is never matched. */
const CLASSIFIED_RULES: Rule[] = [
  {
    // Not an agent failure: nothing reached the agent, so there is no turn to
    // continue. The message names the setting or file and why it failed.
    // Settings has no page per project (they open from the project's menu),
    // so the link goes to the global page and the hint points at the menu.
    test: (code) => code === SETTINGS_READ_FAILED,
    presentation: {
      title: "Cadencr couldn't read a setting this conversation needs",
      hint: "Nothing was sent to the agent. Fix the setting or file below, then try again. A project's own settings are under Project Settings in its sidebar menu.",
      actions: ["openSettings"],
      showCause: true,
    },
  },
  {
    test: (code) => code === "PROVIDER_REQUEST_REJECTED",
    presentation: {
      title: "The agent's CLI rejected a request from Cadencr",
      hint: "The request didn't fit the CLI's version or the conversation's state. The exact error is in the details below.",
      actions: ["continue"],
    },
  },
  {
    test: (code) => code === "BRANCH_SURGERY_FAILED" || code === "UNSUPPORTED_BRANCHING",
    presentation: {
      title: "The conversation couldn't be rewound or forked",
      hint: "Nothing was changed. The exact error is in the details below.",
      actions: [],
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

const RULES: Rule[] = [
  ...CLASSIFIED_RULES,
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
