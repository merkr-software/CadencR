import { useCallback, useMemo, useRef, useState } from "react";
import { useListVirtualSkills, type VirtualSkillPayload } from "@/api/generated";
import {
  applyVirtualSkillConfig,
  EMPTY_VIRTUAL_SKILL_CONFIG,
  hasVirtualSkillParameters,
  virtualSkillCommandOf,
  type VirtualSkillConfig,
} from "@/lib/virtual-skill-config";

export type VirtualSkillWizardState =
  | { status: "none" }
  | { status: "loading"; command: string }
  | { status: "error"; command: string; error: unknown }
  | {
      status: "ready";
      skill: VirtualSkillPayload;
      config: VirtualSkillConfig;
      setConfig: (config: VirtualSkillConfig) => void;
    };

export interface VirtualSkillWizard {
  state: VirtualSkillWizardState;
  /** The outgoing prompt with the pinned configuration written into it. */
  decorate: (text: string) => string;
}

/**
 * The skill wizard of a composer: which configurable `/cadencr:*` skill the
 * draft invokes and what the user pinned for it. Each skill keeps its last
 * configuration for the composer's lifetime, so a failed send, a recalled
 * prompt or a second run starts from the same choices.
 */
export function useVirtualSkillWizard(text: string): VirtualSkillWizard {
  const command = virtualSkillCommandOf(text);
  // Static and tiny: fetched once per app session, ahead of the first skill, so
  // typing `/cadencr:r…` never mounts a loading tray that a partial name drops.
  const catalog = useListVirtualSkills({ query: { staleTime: Infinity } });
  const [stored, setStored] = useState<Readonly<Record<string, VirtualSkillConfig>>>({});
  const config = (command && stored[command]) || EMPTY_VIRTUAL_SKILL_CONFIG;
  const setConfig = useCallback(
    (next: VirtualSkillConfig): void => {
      if (command) setStored((current) => ({ ...current, [command]: next }));
    },
    [command],
  );
  const skill = command ? catalog.data?.find((entry) => entry.command === command) : undefined;
  const configurable = skill && hasVirtualSkillParameters(skill) ? skill : undefined;

  // Read at send time: the send runner keeps a stable callback.
  const latest = useRef({ skill: configurable, config });
  latest.current = { skill: configurable, config };
  const decorate = useCallback((outgoing: string): string => {
    const { skill: current, config: pinned } = latest.current;
    return current ? applyVirtualSkillConfig(outgoing, current, pinned) : outgoing;
  }, []);

  const state = useMemo((): VirtualSkillWizardState => {
    if (command == null) return { status: "none" };
    if (catalog.isError) return { status: "error", command, error: catalog.error };
    if (catalog.isLoading) return { status: "loading", command };
    // `/cadencr:side` and unknown names are not in the catalog.
    if (!configurable) return { status: "none" };
    return { status: "ready", skill: configurable, config, setConfig };
  }, [catalog.error, catalog.isError, catalog.isLoading, command, config, configurable, setConfig]);

  return useMemo(() => ({ state, decorate }), [decorate, state]);
}
