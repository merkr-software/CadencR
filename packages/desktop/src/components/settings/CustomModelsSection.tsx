import { CustomModelEditor } from "./CustomModelEditor";
import { translateUi, useUiTranslation } from "@/lib/i18n/ui";
import { useState } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import {
  useClaudeCodeCustomModels,
  useDeleteClaudeCodeCustomModel,
  type RuntimeModelOption,
} from "@/api/agentRuntime";
import { SettingsHeading } from "./SettingsHeading";
import { ErrorRow, LoadingRow, toastCallbacks } from "./SettingsStateRows";

export function CustomModelsSection() {
  const { t } = useUiTranslation();
  const modelsQuery = useClaudeCodeCustomModels();
  const deleteModel = useDeleteClaudeCodeCustomModel();
  const [editing, setEditing] = useState<
    { mode: "create" } | { mode: "edit"; model: RuntimeModelOption } | null
  >(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  const models = modelsQuery.data?.models ?? [];

  const handleConfirmDelete = () => {
    if (!pendingDelete) return;
    const modelId = pendingDelete;
    deleteModel.mutate(
      { modelId },
      toastCallbacks(
        () =>
          translateUi(
            "settings.providers.customModelsSection.deleted",
            'Custom model "{{name}}" deleted',
            { name: modelId },
          ),
        () =>
          translateUi(
            "settings.providers.customModelsSection.deleteError",
            "Failed to delete model",
          ),
      ),
    );
  };

  return (
    <section className="space-y-4">
      <SettingsHeading
        title={t("settings.providers.customModelsSection.customModels", "Custom models")}
        description={t(
          "settings.providers.customModelsSection.additionalModelIDsMergedIntoTheCatalog",
          "Additional model IDs merged into the catalog. Examples include older aliases, Bedrock ARNs, or gateway names.",
        )}
        action={
          <Button variant="outline" size="sm" onClick={() => setEditing({ mode: "create" })}>
            <Plus className="size-3.5" />{" "}
            {t("settings.providers.customModelsSection.newModel", "New model")}
          </Button>
        }
      />

      {modelsQuery.isLoading ? (
        <LoadingRow
          label={t(
            "settings.providers.customModelsSection.loadingCustomModels",
            "Loading custom models…",
          )}
        />
      ) : modelsQuery.isError ? (
        <ErrorRow
          label={t(
            "settings.providers.customModelsSection.failedToLoadCustomModels",
            "Failed to load custom models.",
          )}
        />
      ) : models.length === 0 ? (
        <div className="rounded-md border border-border bg-card px-4 py-6 text-sm text-muted-foreground">
          {t("settings.providers.customModelsSection.noCustomModelsYet", "No custom models yet.")}
        </div>
      ) : (
        <CustomModelsList
          models={models}
          onEdit={(model) => setEditing({ mode: "edit", model })}
          onDelete={setPendingDelete}
        />
      )}

      {editing && (
        <CustomModelEditor
          initial={editing.mode === "edit" ? editing.model : undefined}
          existingIds={models.map((m) => m.id)}
          onClose={() => setEditing(null)}
        />
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
        title={t(
          "settings.providers.customModelsSection.deleteTitle",
          'Delete custom model "{{name}}"?',
          { name: pendingDelete ?? "" },
        )}
        description={t(
          "settings.providers.customModelsSection.theModelWillNoLongerAppearIn",
          "The model will no longer appear in the model picker.",
        )}
        confirmText={t("settings.providers.customModelsSection.delete", "Delete")}
        variant="destructive"
        onConfirm={handleConfirmDelete}
      />
    </section>
  );
}

function CustomModelsList({
  models,
  onEdit,
  onDelete,
}: {
  models: RuntimeModelOption[];
  onEdit: (model: RuntimeModelOption) => void;
  onDelete: (modelId: string) => void;
}) {
  const { t } = useUiTranslation();
  return (
    <div className="rounded-md border border-border bg-card overflow-hidden">
      {models.map((model) => (
        <div
          key={model.id}
          className="flex items-center justify-between gap-4 px-4 py-2.5 border-t border-border first:border-t-0"
        >
          <div className="flex flex-col min-w-0">
            <span className="font-medium text-sm truncate">{model.label}</span>
            <span className="text-xs text-muted-foreground font-mono truncate">{model.id}</span>
            {model.description ? (
              <span className="text-xs text-muted-foreground truncate">{model.description}</span>
            ) : null}
            {model.supports_effort && model.supported_effort_levels?.length ? (
              <span className="text-xs text-muted-foreground truncate">
                {t(
                  "settings.providers.customModelsSection.thinkingLevels",
                  "Thinking: {{efforts}}",
                  { efforts: model.supported_effort_levels.join(", ") },
                )}
                {model.default_effort_level
                  ? t(
                      "settings.providers.customModelsSection.defaultEffort",
                      " (default: {{effort}})",
                      { effort: model.default_effort_level },
                    )
                  : ""}
              </span>
            ) : null}
          </div>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => onEdit(model)}
              aria-label={t("settings.providers.customModelsSection.edit", "Edit {{name}}", {
                name: model.id,
              })}
            >
              <Pencil className="size-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => onDelete(model.id)}
              aria-label={t("settings.providers.customModelsSection.remove", "Delete {{name}}", {
                name: model.id,
              })}
              className="text-destructive hover:text-destructive"
            >
              <Trash2 className="size-3.5" />
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}
