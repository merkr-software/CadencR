// Drop-target id shared by the agent's outer container (which owns the
// drop zone) and `useImageAttachments` inside `AgentPromptBar`. Both must
// derive the same string from the same inputs — otherwise a drop on the
// section would resolve to one id while the hook listens for another and
// the file silently never attaches.

export interface PromptDropTargetArgs {
  wsSessionId?: string | null;
  dbSessionId?: number | null;
  featureId?: number | null;
}

export function promptDropTargetIdOf(args: PromptDropTargetArgs): string {
  if (args.wsSessionId) return `ws:${args.wsSessionId}`;
  if (args.dbSessionId) return `db:${args.dbSessionId}`;
  if (args.featureId) return `feature:${args.featureId}`;
  // Defensive: every real call site has at least one of the three above,
  // but if a future caller drops in without one we still emit a stable id
  // so the section and the hook agree on "no real target".
  return "prompt:unknown";
}
