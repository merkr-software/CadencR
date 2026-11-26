import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAgentProfiles, type AgentProfileOption } from "@/api/agentRuntime";
import type { ClaudeProfileSelection } from "./useClaudeProfileSelection";

const EMPTY_PROFILES: AgentProfileOption[] = [];

/** Provider-neutral profile selection. The returned legacy field names keep the
 * existing presentational components wire-compatible while they are renamed. */
export function useAgentProfileSelection({
  providerId,
  supportsProfiles,
  cwd,
  wsSessionId,
  sessionProfile,
  onSessionProfileChange,
}: {
  providerId: string;
  supportsProfiles: boolean;
  cwd?: string;
  wsSessionId?: string;
  sessionProfile?: string;
  onSessionProfileChange?: (profile: string) => void;
}): ClaudeProfileSelection {
  const query = useAgentProfiles(supportsProfiles ? providerId : undefined, cwd);
  const touched = useRef(false);
  const scope = useRef(`${wsSessionId ?? ""}:${providerId}`);
  const profiles = query.data?.profiles ?? EMPTY_PROFILES;
  const active =
    query.data?.active_profile ?? query.data?.default_profile ?? profiles[0]?.id ?? "default";
  const [selected, setSelected] = useState(active);
  // A missing or failed catalog cannot authorize replacing a pinned profile.
  const localProfile =
    touched.current && scope.current === `${wsSessionId ?? ""}:${providerId}` ? selected : active;
  const promptProfile =
    !query.data || query.isError
      ? undefined
      : sessionProfile
        ? profiles.some((profile) => profile.id === sessionProfile)
          ? sessionProfile
          : undefined
        : localProfile;
  const change = useCallback(
    (profile: string) => {
      touched.current = true;
      if (!sessionProfile) setSelected(profile);
      onSessionProfileChange?.(profile);
    },
    [onSessionProfileChange, sessionProfile],
  );
  useEffect(() => {
    const nextScope = `${wsSessionId ?? ""}:${providerId}`;
    if (scope.current !== nextScope) {
      scope.current = nextScope;
      touched.current = false;
      setSelected(active);
    }
    if (sessionProfile && profiles.some((profile) => profile.id === sessionProfile)) {
      touched.current = true;
      setSelected(sessionProfile);
    } else if (supportsProfiles && !touched.current) setSelected(active);
  }, [active, profiles, providerId, sessionProfile, supportsProfiles, wsSessionId]);
  return useMemo(
    () => ({
      selectedClaudeProfile: selected,
      promptProfile,
      activeClaudeProfile: active,
      catalogProfile: promptProfile !== active ? promptProfile : undefined,
      claudeProfiles: profiles.map((profile) => ({
        name: profile.id,
        label: profile.label,
        env: {},
      })),
      claudeProfilesLoading: supportsProfiles && query.isLoading,
      claudeProfilesError: supportsProfiles && query.isError,
      handleClaudeProfileChange: change,
    }),
    [
      active,
      change,
      profiles,
      promptProfile,
      query.isError,
      query.isLoading,
      selected,
      supportsProfiles,
    ],
  );
}
