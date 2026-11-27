import type { UiTranslator } from "@/lib/i18n/ui";

interface OptionCopy {
  label: string;
  description: string;
  optionId?: string;
}

// Existing service and saved gate payloads carry English display text alongside their decision.
// Match the entire built-in variant so a custom tool description or option stays verbatim.
const builtInVariants = [
  ["allowToolOnce", "Allow once", "Approve this tool call only"],
  ["allowFutureTools", "Allow future requests", "Apply the provider's suggested permission update"],
  ["denyTool", "Deny", "Reject this tool call"],
  ["allowCodexOnce", "Allow once", "Approve this Codex request"],
  ["allowCodexSession", "Allow for session", "Approve matching requests for this Codex session"],
  ["denyCodex", "Deny", "Reject this Codex request"],
  ["allowOnce", "Allow once", "Approve this request only"],
  [
    "allowOpenCodeSession",
    "Allow for this session",
    "Let OpenCode allow similar requests during this session",
  ],
  ["denyRequest", "Deny", "Reject this request"],
  ["approveRequest", "Approve", "Approve this request only"],
  [
    "approveCodexSession",
    "Approve for session",
    "Approve matching requests for this Codex session",
  ],
  [
    "approveHostSession",
    "Allow host for session",
    "Approve matching requests for this Codex session",
  ],
  [
    "approvePermissionsSession",
    "Allow permissions for session",
    "Approve matching requests for this Codex session",
  ],
  [
    "approveSimilar",
    "Approve similar commands",
    "Approve this command and future commands matching Codex's proposed rule",
  ],
  ["allowFutureHost", "Allow host in future", "Apply Codex's proposed network policy rule"],
  ["blockFutureHost", "Block host in future", "Apply Codex's proposed network policy rule"],
  ["denyContinue", "Deny and continue", "Reject this request and let Codex continue"],
  [
    "denyFeedback",
    "Deny with feedback",
    "Reject this request and tell Codex what to do differently",
  ],
  ["cancelTurn", "Cancel", "Reject this request and stop the current turn"],
  ["approveFiles", "Approve", "Apply these file changes"],
  [
    "approveFutureFiles",
    "Approve for session",
    "Approve future changes to the same files this session",
  ],
  [
    "denyFiles",
    "Deny with feedback",
    "Reject these file changes and tell Codex what to do differently",
  ],
  ["grantTurn", "Grant for turn", "Grant these permissions for the current turn"],
  [
    "grantStrict",
    "Grant with strict review",
    "Grant for this turn and review subsequent commands strictly",
  ],
  ["grantSession", "Grant for session", "Grant these permissions for this Codex session"],
  ["denyGrant", "Deny", "Continue without granting these permissions"],
  ["approveElicitation", "Approve", "Accept this MCP elicitation"],
  ["persistElicitation", "Always approve", "Accept and let Codex persist this MCP approval"],
  [
    "approveSessionElicitation",
    "Approve for session",
    "Accept matching MCP approvals for this Codex session",
  ],
  ["declineElicitation", "Deny and continue", "Decline this MCP elicitation"],
  ["cancelElicitation", "Cancel", "Cancel this MCP elicitation"],
  ["allowSingle", "Allow", "Approve this single request"],
  ["allowSimilar", "Always allow", "Approve similar requests in this and future sessions"],
  [
    "allowSimilarSession",
    "Allow for this session",
    "Approve similar requests for the rest of this session",
  ],
] as const;

export function permissionOptionCopy(
  t: UiTranslator,
  option: OptionCopy,
): Pick<OptionCopy, "label" | "description"> {
  const { label, description, optionId } = option;
  if (
    optionId &&
    !/^(?:codex(?:_legacy|_elicitation)?:|codex_permissions_strict_auto_review$|allow_(?:once|future|always|for_session)$|reject_once$|deny$)/.test(
      optionId,
    )
  )
    return { label, description };
  const variant = builtInVariants.find(
    ([, name, detail]) => name === label && detail === description,
  );
  if (!variant) return { label, description };
  return {
    label: t(`permission.option.${variant[0]}.label`, label),
    description: t(`permission.option.${variant[0]}.description`, description),
  };
}
