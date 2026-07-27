/**
 * Claude's per-schedule profile selector.
 *
 * Profiles are a Claude Code concept — billing identity, not a runtime axis the
 * catalog advertises for every agent — so the knowledge that they exist is
 * confined to this file rather than living as a branch inside the generic chip
 * row (`provider-boundaries.md`). `ScheduleSettingsBar` renders it
 * unconditionally; it returns `null` for every provider that has no profiles,
 * which is the same shape `ScheduleAccessChip` uses for its own axis.
 *
 * This mirrors `useClaudeProfileSelection` on the session side: the schedule
 * pins a profile for its own runs and never touches the globally active one.
 */
import { type ReactElement } from "react";
import { ClaudeProfileCombobox } from "@/components/agent-session/ClaudeProfileCombobox";
import { useClaudeCodeProfiles, DEFAULT_CLAUDE_PROFILE_NAME } from "@/api/agentRuntime";
import { PROVIDER_IDS } from "@/lib/providers";
import type { ScheduleChipProps } from "./ScheduleModelChip";

/** Claude bills per profile, so a schedule can run under a different one than
 *  the user is working in. Other providers have no equivalent. */
export function ScheduleProfileChip({
  target,
  onChange,
  runtime,
}: ScheduleChipProps): ReactElement | null {
  const isClaude = runtime.providerId === PROVIDER_IDS.CLAUDE_CODE;
  const profiles = useClaudeCodeProfiles({ enabled: isClaude });
  if (!isClaude) return null;
  // Nothing to choose between when only the default profile exists — but that
  // is only knowable once the query answers. Folding the unresolved case into
  // the same check reads as "no profiles" while the fetch is in flight, so the
  // chip would pop in when it settled, and a failure would be indistinguishable
  // from a provider that simply has none. Deferring to the combobox lets it
  // show its own loading and error states, as it does in the composer.
  const isResolved = !profiles.isLoading && !profiles.isError;
  if (isResolved && (profiles.data?.profiles?.length ?? 0) === 0) return null;
  return (
    <ClaudeProfileCombobox
      value={runtime.profile ?? profiles.data?.active ?? DEFAULT_CLAUDE_PROFILE_NAME}
      profiles={profiles.data?.profiles ?? []}
      isLoading={profiles.isLoading}
      isError={profiles.isError}
      onChange={(profile) => onChange({ ...target, profile })}
      variant="compact"
      label="Profile"
    />
  );
}
