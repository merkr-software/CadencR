import type { ReactElement } from "react";
import { SquareTerminalIcon } from "lucide-react";
import { CleanupOption } from "@/components/CleanupOption";
import { closeFeatureActivityNoun } from "@/lib/feature-activity-close";

interface KillTerminalsOptionProps {
  count: number;
  /** Browser tabs closed along with the shells (the archive dialog's). */
  browserCount?: number;
  checked: boolean;
  onToggle: () => void;
}

/** Cleanup-dialog option to kill the feature's running shells (shortcut `T`). */
export function KillTerminalsOption(props: KillTerminalsOptionProps): ReactElement {
  const browserCount = props.browserCount ?? 0;
  const shells = `${props.count} running ${props.count === 1 ? "shell" : "shells"}`;
  const tabs = `${browserCount} browser ${browserCount === 1 ? "tab" : "tabs"}`;
  const parts = [
    props.count > 0 ? `Stop the ${shells}` : null,
    browserCount > 0 ? `close the ${tabs}` : null,
  ]
    .filter((part): part is string => part != null)
    .join(" and ");
  return (
    <CleanupOption
      checked={props.checked}
      icon={<SquareTerminalIcon className="size-4" />}
      label={
        browserCount > 0
          ? `Close ${closeFeatureActivityNoun(props.count, browserCount)}`
          : "Kill terminals"
      }
      shortcut="T"
      description={`${parts.charAt(0).toUpperCase()}${parts.slice(1)} in this session.`}
      onCheckedChange={props.onToggle}
    />
  );
}
