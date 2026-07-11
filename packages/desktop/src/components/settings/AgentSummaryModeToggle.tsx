import { ListChecks } from "lucide-react";
import { SettingsSwitchRow } from "./SettingsSwitchRow";
import { useDebouncedSetting } from "@/hooks/useDebouncedSetting";
import { AGENT_SUMMARY_MODE_SETTING_KEY, parseAgentSummaryMode } from "@/lib/agent-verbosity";

/**
 * Settings → Agent output verbosity row that toggles "Summary mode". When on,
 * each finished agent turn's tool calls collapse into a single recap block
 * (per-tool counts like `Read ×5`, `Bash ×12`) followed by the turn's final
 * message. Defaults to off. Independent of the verbosity mode above.
 */
export function AgentSummaryModeToggle(): React.JSX.Element {
  const setting = useDebouncedSetting(AGENT_SUMMARY_MODE_SETTING_KEY, 0);
  const enabled = parseAgentSummaryMode(setting.value);

  return (
    <SettingsSwitchRow
      icon={<ListChecks className="size-4" />}
      iconTint="green"
      label="Summary mode"
      description="Collapse each turn's tool calls into one recap (e.g. Read ×5, Bash ×12), then show the turn's final message. Keeps the stream focused on results."
      checked={enabled}
      onCheckedChange={(next) => setting.setValue(next ? "true" : "false")}
      disabled={setting.isLoading}
      divided
    />
  );
}
