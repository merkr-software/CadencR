import { useUiTranslation } from "@/lib/i18n/ui";
import { createElement, useMemo } from "react";
import { useSetting } from "@/hooks/useSetting";
import {
  AGENT_VERBOSITY_OPTIONS,
  AGENT_VERBOSITY_SETTING_KEY,
  parseAgentVerbosityMode,
  type AgentVerbosityMode,
} from "@/lib/agent-verbosity";
import { RadioCardGroup, type RadioCardOption } from "@/components/settings/RadioCardGroup";

export function AgentVerbositySettings(): React.JSX.Element {
  const { t } = useUiTranslation();
  const modeSetting = useSetting(AGENT_VERBOSITY_SETTING_KEY);
  const currentMode = parseAgentVerbosityMode(modeSetting.value);

  const options = useMemo<RadioCardOption<AgentVerbosityMode>[]>(
    () =>
      AGENT_VERBOSITY_OPTIONS.map((option) => ({
        value: option.value,
        label: option.label(t),
        description: option.description(t),
        visual: createElement(option.icon, {
          className: "mt-0.5 size-4",
          style: { color: option.iconColorVar },
        }),
      })),
    [t],
  );

  return (
    <RadioCardGroup<AgentVerbosityMode>
      ariaLabel={t("settings.agentOutput.verbosity", "Agent output verbosity")}
      value={currentMode}
      onChange={modeSetting.setValue}
      options={options}
      layout="stack"
      showDot={false}
      disabled={modeSetting.isLoading}
    />
  );
}
