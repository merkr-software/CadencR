import { createElement } from "react";
import { AGENT_ICONS } from "@/components/agent-icons";
import { ModelSelectorRow } from "@/components/ModelSelectorRow";
import { useModelSelectorState } from "@/hooks/useModelSelectorState";
import { MODEL_SELECTOR_AGENT_LABELS, type ModelSelectorLevel } from "@/hooks/modelSelectorShared";

interface ModelSelectorProps {
  level: ModelSelectorLevel;
  projectId?: number;
  featureId?: number;
}

export function ModelSelector({ level, projectId, featureId }: ModelSelectorProps) {
  const { isLoading, hasCatalogError, hasSelectionError, rows } = useModelSelectorState({
    level,
    projectId,
    featureId,
  });

  if (isLoading) {
    return <div className="text-sm text-muted-foreground">Loading model settings...</div>;
  }

  if (hasCatalogError) {
    return <div className="text-sm text-destructive">Failed to load provider catalog.</div>;
  }

  if (hasSelectionError) {
    return <div className="text-sm text-destructive">Failed to load the model selection.</div>;
  }

  return (
    <div className="rounded-xl border border-border/60 bg-card/30 p-2">
      {rows.map((row) => (
        <ModelSelectorRow
          key={row.agentType}
          agentLabel={MODEL_SELECTOR_AGENT_LABELS[row.agentType] ?? row.agentType}
          stateLabel={row.stateLabel}
          level={level}
          selectedProviderId={row.selectedProviderId}
          selectedProviderLabel={row.selectedProviderLabel}
          selectedModelId={row.selectedModelId}
          selectedModelLabel={row.selectedModelLabel}
          selectedModelDescription={row.selectedModelDescription}
          providers={row.providers}
          isInherited={row.isInherited}
          onInherit={row.onInherit}
          onSelect={row.onSelect}
          icon={createElement(AGENT_ICONS[row.agentType], { className: "size-4" })}
        />
      ))}
    </div>
  );
}
