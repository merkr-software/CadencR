import { Button } from "./ui/button";
import { ProviderIcon } from "@/lib/provider-icons";
import { resolveProviderModelAlias } from "@/lib/provider-model-aliases";
import { RuntimeModelPicker } from "@/components/RuntimeModelPicker";
import type { RuntimeModelOption } from "@/api/agentRuntime";
import type { ModelSelectorLevel } from "@/hooks/modelSelectorShared";
import { ChevronDownIcon } from "lucide-react";

export interface ModelSelectorRowProvider {
  id: string;
  label: string;
  disabled: boolean;
  status: "available" | "unavailable" | "coming_soon";
  statusMessage?: string;
  refreshError?: string;
  models: RuntimeModelOption[];
}

interface ModelSelectorRowProps {
  agentLabel: string;
  stateLabel: string;
  level: ModelSelectorLevel;
  selectedProviderId: string;
  selectedProviderLabel: string;
  selectedModelId: string;
  selectedModelLabel: string;
  selectedModelDescription?: string;
  providers: ModelSelectorRowProvider[];
  isInherited: boolean;
  onInherit?: () => void;
  onSelect: (providerId: string, modelId: string) => void;
  icon: React.ReactNode;
}

export function ModelSelectorRow(props: ModelSelectorRowProps) {
  const {
    agentLabel,
    stateLabel,
    level,
    selectedProviderId,
    selectedProviderLabel,
    selectedModelId,
    selectedModelLabel,
    selectedModelDescription,
    providers,
    isInherited,
    onInherit,
    onSelect,
    icon,
  } = props;

  const inheritAction =
    level !== "global" && onInherit
      ? {
          id: "inherit-selection",
          label: "Inherit selection",
          description: selectedModelLabel,
          selected: isInherited,
          keywords: [selectedProviderLabel, selectedModelLabel],
          onSelect: onInherit,
        }
      : undefined;

  return (
    <div className="flex flex-col gap-2.5 rounded-lg px-3 py-2.5 sm:flex-row sm:items-center sm:gap-4">
      <div className="flex min-w-0 items-center gap-2.5 sm:w-[180px] sm:flex-none">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border/60 bg-background/60 text-muted-foreground">
          {icon}
        </div>
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-foreground">{agentLabel}</div>
          <div className="truncate text-[11px] text-muted-foreground">{stateLabel}</div>
        </div>
      </div>
      <div className="flex min-w-0 w-full items-center gap-2 sm:flex-1">
        <div className="min-w-0 flex-1">
          <RuntimeModelPicker
            providers={providers}
            selectedProviderId={selectedProviderId}
            selectedModelId={selectedModelId}
            resolveSelectedModelId={resolveProviderModelAlias}
            onSelect={onSelect}
            action={inheritAction}
            trigger={
              <Button
                variant="outline"
                role="combobox"
                className="h-10 w-full min-w-0 justify-between gap-3 rounded-lg border-border/70 bg-background/80 px-3 text-left text-xs font-normal shadow-sm"
                title={selectedModelDescription ?? selectedModelLabel}
              >
                <span className="flex min-w-0 items-center gap-2.5 overflow-hidden">
                  <ProviderIcon
                    providerId={selectedProviderId}
                    alt={selectedProviderLabel}
                    className="size-4 shrink-0 rounded-sm"
                  />
                  <span className="min-w-0 truncate">
                    <span className="truncate text-sm text-foreground">{selectedModelLabel}</span>
                    {level !== "global" && isInherited && (
                      <span className="ml-1 hidden truncate text-[11px] text-muted-foreground sm:inline">
                        Inherited
                      </span>
                    )}
                  </span>
                </span>
                <ChevronDownIcon className="size-3 shrink-0 opacity-50" />
              </Button>
            }
          />
        </div>
      </div>
    </div>
  );
}
