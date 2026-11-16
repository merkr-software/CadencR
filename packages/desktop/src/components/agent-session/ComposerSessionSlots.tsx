import { useMemo } from "react";
import type { SessionInfoPanelProps } from "./SessionInfoChip";
import type { AgentSessionComposerProps } from "./AgentSessionComposer";

/**
 * The session details the composer's "…" menu opens (what the old Info chip
 * showed), or undefined when the session has nothing to show yet.
 */
export function useComposerSessionInfo(
  props: AgentSessionComposerProps,
): SessionInfoPanelProps | undefined {
  const session = props.sessionProps;
  const showProfileSelector =
    props.showClaudeProfileSelector && !!props.claudeProfile && !!props.onClaudeProfileChange;
  const hasSession = !!session.runtimeSessionId && !!session.onStop;
  const isRunning = session.status === "agent";
  return useMemo(
    () =>
      showProfileSelector || hasSession
        ? {
            runtimeProvider: session.selection?.providerId,
            runtimeSessionId: session.runtimeSessionId,
            projectPath: props.projectPath,
            featureId: session.featureId,
            wsSessionId: session.wsSessionId,
            isRunning,
            onPause: session.onStop,
            claudeProfile: props.claudeProfile,
            claudeProfiles: props.claudeProfiles,
            claudeProfilesLoading: props.claudeProfilesLoading,
            claudeProfilesError: props.claudeProfilesError,
            activeClaudeProfile: props.activeClaudeProfile,
            onClaudeProfileChange: props.onClaudeProfileChange,
            showProfileSelector,
          }
        : undefined,
    [
      hasSession,
      isRunning,
      props.activeClaudeProfile,
      props.claudeProfile,
      props.claudeProfiles,
      props.claudeProfilesError,
      props.claudeProfilesLoading,
      props.onClaudeProfileChange,
      props.projectPath,
      session.featureId,
      session.onStop,
      session.runtimeSessionId,
      session.selection?.providerId,
      session.wsSessionId,
      showProfileSelector,
    ],
  );
}
