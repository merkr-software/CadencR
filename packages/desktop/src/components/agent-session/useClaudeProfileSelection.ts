import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_CLAUDE_PROFILE_NAME,
  useClaudeCodeProfiles,
  type ClaudeCodeProfile,
} from "../../api/agentRuntime";

const EMPTY_CLAUDE_PROFILES: ClaudeCodeProfile[] = [];

export interface ClaudeProfileSelection {
  selectedClaudeProfile: string;
  /**
   * Profile to scope the agent-catalog model probe to, or `undefined` to let
   * the backend use the active profile. Only set when the user has picked a
   * profile that differs from the active one — so the default/initial state
   * never triggers a redundant (and CLI-spawning) probe.
   */
  catalogProfile: string | undefined;
  claudeProfiles: ClaudeCodeProfile[];
  claudeProfilesLoading: boolean;
  claudeProfilesError: boolean;
  handleClaudeProfileChange: (profile: string) => void;
}

export function useClaudeProfileSelection({
  isClaudeProvider,
  wsSessionId,
  sessionProfile,
  onSessionProfileChange,
}: {
  isClaudeProvider: boolean;
  wsSessionId?: string;
  sessionProfile?: string;
  onSessionProfileChange?: (profile: string) => void;
}): ClaudeProfileSelection {
  const profileTouchedRef = useRef(false);
  const conversationRef = useRef(wsSessionId);
  const profilesQuery = useClaudeCodeProfiles({ enabled: isClaudeProvider });
  const activeClaudeProfile = profilesQuery.data?.active ?? DEFAULT_CLAUDE_PROFILE_NAME;
  const [selectedClaudeProfile, setSelectedClaudeProfile] = useState(DEFAULT_CLAUDE_PROFILE_NAME);

  const handleClaudeProfileChange = useCallback(
    (profile: string): void => {
      profileTouchedRef.current = true;
      setSelectedClaudeProfile(profile);
      onSessionProfileChange?.(profile);
    },
    [onSessionProfileChange],
  );

  // Mirror the configured active profile until the user explicitly picks one for
  // the current conversation. Switching conversations forgets that manual pick so
  // the new conversation re-adopts the configured default — even when
  // `activeClaudeProfile` is already settled and unchanged, which is the bug
  // behind new conversations not honoring the configured default profile (#77).
  useEffect(() => {
    if (conversationRef.current !== wsSessionId) {
      conversationRef.current = wsSessionId;
      profileTouchedRef.current = false;
    }
    if (isClaudeProvider && sessionProfile) {
      profileTouchedRef.current = true;
      setSelectedClaudeProfile((current) =>
        current === sessionProfile ? current : sessionProfile,
      );
      return;
    }
    if (isClaudeProvider && !profileTouchedRef.current) {
      setSelectedClaudeProfile((current) =>
        current === activeClaudeProfile ? current : activeClaudeProfile,
      );
    }
  }, [isClaudeProvider, activeClaudeProfile, sessionProfile, wsSessionId]);

  const profiles = profilesQuery.data?.profiles ?? EMPTY_CLAUDE_PROFILES;
  // Scope the catalog probe only once profiles have loaded and the user's pick
  // differs from the active profile — otherwise the backend already probes the
  // active env, so leaving this undefined avoids a redundant model probe.
  const activeProfile = profilesQuery.data?.active;
  const catalogProfile =
    activeProfile != null && selectedClaudeProfile !== activeProfile
      ? selectedClaudeProfile
      : undefined;
  return useMemo(
    () => ({
      selectedClaudeProfile,
      catalogProfile,
      claudeProfiles: profiles,
      claudeProfilesLoading: isClaudeProvider && profilesQuery.isLoading,
      claudeProfilesError: isClaudeProvider && profilesQuery.isError,
      handleClaudeProfileChange,
    }),
    [
      catalogProfile,
      handleClaudeProfileChange,
      isClaudeProvider,
      profiles,
      profilesQuery.isError,
      profilesQuery.isLoading,
      selectedClaudeProfile,
    ],
  );
}
