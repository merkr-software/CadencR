import { useGetAgentSelection } from "./generated";
import type { AgentSelectionResponse, ResolvedSelection } from "./generated";

interface SelectionScope {
  projectId?: number;
  featureId?: number;
  cwd?: string;
  profile?: string;
  enabled?: boolean;
}

/**
 * Query the backend-resolved provider/model pair, including origin information
 * (why this pair won: feature override, project override, global, or provider default).
 * The backend owns the precedence cascade; this hook just fetches the result.
 */
export function useResolvedSelection(scope: SelectionScope) {
  const { projectId, featureId, cwd, profile, enabled = true } = scope;
  return useGetAgentSelection(
    {
      ...(projectId != null ? { project_id: projectId } : {}),
      ...(featureId != null ? { feature_id: featureId } : {}),
      ...(cwd ? { cwd } : {}),
      ...(profile ? { profile } : {}),
    },
    { query: { enabled } },
  );
}

/**
 * Extract the session's resolved selection from the API response.
 * The response nests selections by agent type (e.g. data.selections.session).
 */
export function sessionSelectionOf(
  response: AgentSelectionResponse | undefined,
): ResolvedSelection | null {
  return response?.selections?.session ?? null;
}
