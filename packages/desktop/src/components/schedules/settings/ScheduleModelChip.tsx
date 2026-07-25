import { useState, type ReactElement } from "react";
import type { ScheduleTarget } from "@/api/generated";
import { ModelMetaChip } from "@/components/agent-session/ModelMetaChip";
import { supportedThinkingEffortLevels } from "@/shared/thinking-effort";
import type { ScheduleRuntime } from "./useScheduleRuntime";

const CATALOG_LOADING_LABEL = "Loading model…";

export interface ScheduleChipProps {
  target: ScheduleTarget;
  onChange: (next: ScheduleTarget) => void;
  runtime: ScheduleRuntime;
}

/**
 * The session composer's model chip, driven from the schedule target.
 *
 * The agent segment is read-only for a `conversation` target — that thread is
 * already bound to its agent — but the model never is: a nightly recap may run
 * a cheap model in a conversation the user drives with an expensive one.
 */
export function ScheduleModelChip({ target, onChange, runtime }: ScheduleChipProps): ReactElement {
  const [open, setOpen] = useState(false);

  return (
    <ModelMetaChip
      open={open}
      onOpenChange={setOpen}
      currentProviderId={runtime.providerId}
      currentModelId={runtime.modelId}
      currentModelLabel={
        runtime.isCatalogLoading
          ? CATALOG_LOADING_LABEL
          : (runtime.model?.label ?? runtime.modelId ?? "Model")
      }
      modelSelectionStatus={runtime.isCatalogLoading ? "catalog-loading" : "ready"}
      pickerProviders={runtime.pickerProviders}
      // Provider and model are written together from the one selection the
      // picker reports — a separate provider callback would race it.
      canChangeProvider={false}
      onModelChange={(pickedProvider, pickedModel) =>
        onChange({
          ...target,
          // The provider never rides along on a conversation target: the
          // backend drops it, and the picker only offers the one it is on.
          provider: target.kind === "conversation" ? undefined : pickedProvider,
          model: pickedModel,
          // Effort levels are per-model; the old one may not exist here.
          thinking_level: undefined,
        })
      }
      currentThinkingEffort={runtime.thinkingLevel}
      supportedThinkingEfforts={supportedThinkingEffortLevels(runtime.model)}
      onThinkingEffortChange={(effort) =>
        onChange({ ...target, thinking_level: effort ?? undefined })
      }
    />
  );
}
