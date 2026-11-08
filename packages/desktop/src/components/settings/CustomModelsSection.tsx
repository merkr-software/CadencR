import { useMemo, useState } from "react";
import { Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import {
  useClaudeCodeCustomModels,
  useDeleteClaudeCodeCustomModel,
  useUpsertClaudeCodeCustomModel,
  type RuntimeModelOption,
} from "@/api/agentRuntime";
import { SettingsHeading } from "./SettingsHeading";
import { ErrorRow, LoadingRow, toastCallbacks } from "./SettingsStateRows";

export function CustomModelsSection() {
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
      toastCallbacks(`Custom model "${modelId}" deleted`, "Failed to delete model"),
    );
  };

  return (
    <section className="space-y-4">
      <SettingsHeading
        title="Custom models"
        description="Additional model IDs merged into the catalog. Examples include older aliases, Bedrock ARNs, or gateway names."
        action={
          <Button variant="outline" size="sm" onClick={() => setEditing({ mode: "create" })}>
            <Plus className="size-3.5" /> New model
          </Button>
        }
      />

      {modelsQuery.isLoading ? (
        <LoadingRow label="Loading custom models…" />
      ) : modelsQuery.isError ? (
        <ErrorRow label="Failed to load custom models." />
      ) : models.length === 0 ? (
        <div className="rounded-md border border-border bg-card px-4 py-6 text-sm text-muted-foreground">
          No custom models yet.
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
        title={`Delete custom model "${pendingDelete}"?`}
        description="The model will no longer appear in the model picker."
        confirmText="Delete"
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
                Thinking: {model.supported_effort_levels.join(", ")}
                {model.default_effort_level ? ` (default: ${model.default_effort_level})` : ""}
              </span>
            ) : null}
          </div>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => onEdit(model)}
              aria-label={`Edit ${model.id}`}
            >
              <Pencil className="size-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => onDelete(model.id)}
              aria-label={`Delete ${model.id}`}
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

function CustomModelEditor({
  initial,
  existingIds,
  onClose,
}: {
  initial?: RuntimeModelOption;
  existingIds: string[];
  onClose: () => void;
}) {
  const upsert = useUpsertClaudeCodeCustomModel();
  const [modelId, setModelId] = useState(initial?.id ?? "");
  const [label, setLabel] = useState(initial?.label ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [supportsEffort, setSupportsEffort] = useState(initial?.supports_effort === true);
  const [effortLevels, setEffortLevels] = useState(
    initial?.supported_effort_levels?.join(", ") ?? "",
  );
  const [defaultEffort, setDefaultEffort] = useState(initial?.default_effort_level ?? "");

  const isEdit = !!initial;
  const trimmedId = modelId.trim();
  const trimmedLabel = label.trim();
  const idError = useMemo(() => {
    if (!trimmedId) return "Model ID is required";
    if (!isEdit && existingIds.includes(trimmedId)) return "A model with this ID already exists";
    return null;
  }, [trimmedId, existingIds, isEdit]);
  const labelError = !trimmedLabel ? "Label is required" : null;
  const parsedEffortLevels = useMemo(() => parseEffortLevels(effortLevels), [effortLevels]);
  const effortError = supportsEffort
    ? validateEffortFields(parsedEffortLevels, defaultEffort.trim())
    : null;

  const canSave = !idError && !labelError && !effortError && !upsert.isPending;

  const handleSave = () => {
    if (!canSave) return;
    upsert.mutate(
      {
        modelId: trimmedId,
        data: {
          label: trimmedLabel,
          description: description.trim() || undefined,
          supports_effort: supportsEffort,
          supported_effort_levels: supportsEffort ? parsedEffortLevels : undefined,
          default_effort_level: supportsEffort ? defaultEffort.trim() || undefined : undefined,
        },
      },
      toastCallbacks(`Custom model "${trimmedId}" saved`, "Failed to save custom model", onClose),
    );
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <CustomModelDialogHeader initial={initial} />
        <div className="space-y-4 py-2">
          <CustomModelIdentityFields
            modelId={modelId}
            label={label}
            description={description}
            isEdit={isEdit}
            idError={idError}
            labelError={labelError}
            onModelIdChange={setModelId}
            onLabelChange={setLabel}
            onDescriptionChange={setDescription}
          />
          <EffortFields
            enabled={supportsEffort}
            levels={effortLevels}
            defaultEffort={defaultEffort}
            error={effortError}
            onEnabledChange={setSupportsEffort}
            onLevelsChange={setEffortLevels}
            onDefaultChange={setDefaultEffort}
          />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!canSave} onClick={handleSave}>
            {upsert.isPending ? <Loader2 className="size-3.5 animate-spin" /> : null}
            Save model
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CustomModelDialogHeader({ initial }: { initial?: RuntimeModelOption }) {
  return (
    <DialogHeader>
      <DialogTitle>{initial ? `Edit "${initial.id}"` : "New custom model"}</DialogTitle>
      <DialogDescription>
        The model ID is passed to the Claude CLI via <code>--model</code>. Use any value your active
        profile's backend understands.
      </DialogDescription>
    </DialogHeader>
  );
}

function CustomModelIdentityFields({
  modelId,
  label,
  description,
  isEdit,
  idError,
  labelError,
  onModelIdChange,
  onLabelChange,
  onDescriptionChange,
}: {
  modelId: string;
  label: string;
  description: string;
  isEdit: boolean;
  idError: string | null;
  labelError: string | null;
  onModelIdChange: (value: string) => void;
  onLabelChange: (value: string) => void;
  onDescriptionChange: (value: string) => void;
}) {
  return (
    <>
      <div className="space-y-1.5">
        <label className="text-sm font-medium">Model ID</label>
        <Input
          className="font-mono text-xs"
          value={modelId}
          onChange={(event) => onModelIdChange(event.target.value)}
          placeholder="claude-sonnet-3-5-20241022"
          disabled={isEdit}
          aria-invalid={!!idError}
        />
        {idError ? <p className="text-xs text-destructive">{idError}</p> : null}
      </div>
      <div className="space-y-1.5">
        <label className="text-sm font-medium">Label</label>
        <Input
          value={label}
          onChange={(event) => onLabelChange(event.target.value)}
          placeholder="Sonnet 3.5 (legacy)"
          aria-invalid={!!labelError}
        />
        {labelError ? <p className="text-xs text-destructive">{labelError}</p> : null}
      </div>
      <div className="space-y-1.5">
        <label className="text-sm font-medium">Description</label>
        <Input
          value={description}
          onChange={(event) => onDescriptionChange(event.target.value)}
          placeholder="Older model via Bedrock"
        />
      </div>
    </>
  );
}

function EffortFields({
  enabled,
  levels,
  defaultEffort,
  error,
  onEnabledChange,
  onLevelsChange,
  onDefaultChange,
}: {
  enabled: boolean;
  levels: string;
  defaultEffort: string;
  error: string | null;
  onEnabledChange: (enabled: boolean) => void;
  onLevelsChange: (levels: string) => void;
  onDefaultChange: (effort: string) => void;
}) {
  return (
    <div className="space-y-3 rounded-md border border-border p-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <label htmlFor="custom-model-effort" className="text-sm font-medium">
            Supports thinking effort
          </label>
          <p className="text-xs text-muted-foreground">
            Show the thinking-level control when this model is selected.
          </p>
        </div>
        <Switch id="custom-model-effort" checked={enabled} onCheckedChange={onEnabledChange} />
      </div>
      {enabled ? (
        <div className="space-y-3">
          <div className="space-y-1.5">
            <label className="text-sm font-medium">Supported effort levels</label>
            <Input
              className="font-mono text-xs"
              value={levels}
              onChange={(event) => onLevelsChange(event.target.value)}
              placeholder="low, medium, high, xhigh"
              aria-invalid={!!error}
            />
            <p className="text-xs text-muted-foreground">
              Comma-separated, in the order shown by the thinking selector.
            </p>
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium">Default effort level</label>
            <Input
              className="font-mono text-xs"
              value={defaultEffort}
              onChange={(event) => onDefaultChange(event.target.value)}
              placeholder="medium (optional)"
              aria-invalid={!!error}
            />
          </div>
          {error ? <p className="text-xs text-destructive">{error}</p> : null}
        </div>
      ) : null}
    </div>
  );
}

export function parseEffortLevels(value: string): string[] {
  return value
    .split(",")
    .map((level) => level.trim())
    .filter(Boolean);
}

export function validateEffortFields(levels: string[], defaultEffort: string): string | null {
  if (levels.length === 0) return "At least one supported effort level is required";
  if (new Set(levels).size !== levels.length) return "Supported effort levels must be unique";
  if (defaultEffort && !levels.includes(defaultEffort)) {
    return "Default effort must be one of the supported levels";
  }
  return null;
}
