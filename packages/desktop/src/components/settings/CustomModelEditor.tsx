import { useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { translateUi, UiTrans, useUiTranslation, type UiTranslator } from "@/lib/i18n/ui";
import { useUpsertClaudeCodeCustomModel, type RuntimeModelOption } from "@/api/agentRuntime";
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
import { toastCallbacks } from "./SettingsStateRows";

export function CustomModelEditor({
  initial,
  existingIds,
  onClose,
}: {
  initial?: RuntimeModelOption;
  existingIds: string[];
  onClose: () => void;
}) {
  const { t } = useUiTranslation();
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
  const idError = modelIdError(trimmedId, existingIds, isEdit, t);
  const labelError = !trimmedLabel
    ? t("settings.providers.customModelsSection.labelRequired", "Label is required")
    : null;
  const parsedEffortLevels = useMemo(() => parseEffortLevels(effortLevels), [effortLevels]);
  const effortError = supportsEffort
    ? validateEffortFields(parsedEffortLevels, defaultEffort.trim(), t)
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
      saveModelToasts(trimmedId, onClose),
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
            {t("settings.providers.customModelsSection.cancel", "Cancel")}
          </Button>
          <Button disabled={!canSave} onClick={handleSave}>
            {upsert.isPending ? <Loader2 className="size-3.5 animate-spin" /> : null}
            {t("settings.providers.customModelsSection.saveButton", "Save model")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CustomModelDialogHeader({ initial }: { initial?: RuntimeModelOption }) {
  const { t } = useUiTranslation();
  return (
    <DialogHeader>
      <DialogTitle>
        {initial
          ? t("settings.providers.customModelsSection.editTitle", 'Edit "{{name}}"', {
              name: initial.id,
            })
          : t("settings.providers.customModelsSection.newTitle", "New custom model")}
      </DialogTitle>
      <DialogDescription>
        <UiTrans
          i18nKey="settings.providers.customModelsSection.modelHelp"
          defaults={
            "The model ID is passed to the Claude CLI via <code>{{flag}}</code>. Use any value your active profile's backend understands."
          }
          components={{ code: <code /> }}
          values={{ flag: "--model" }}
        />
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
  const { t } = useUiTranslation();
  return (
    <>
      <div className="space-y-1.5">
        <label className="text-sm font-medium">
          {t("settings.providers.customModelsSection.modelId", "Model ID")}
        </label>
        <Input
          className="font-mono text-xs"
          value={modelId}
          onChange={(event) => onModelIdChange(event.target.value)}
          placeholder={"claude-sonnet-3-5-20241022"}
          disabled={isEdit}
          aria-invalid={!!idError}
        />
        {idError ? <p className="text-xs text-destructive">{idError}</p> : null}
      </div>
      <div className="space-y-1.5">
        <label className="text-sm font-medium">
          {t("settings.providers.customModelsSection.label", "Label")}
        </label>
        <Input
          value={label}
          onChange={(event) => onLabelChange(event.target.value)}
          placeholder={t(
            "settings.providers.customModelsSection.sonnet35Legacy",
            "Sonnet 3.5 (legacy)",
          )}
          aria-invalid={!!labelError}
        />
        {labelError ? <p className="text-xs text-destructive">{labelError}</p> : null}
      </div>
      <div className="space-y-1.5">
        <label className="text-sm font-medium">
          {t("settings.providers.customModelsSection.description", "Description")}
        </label>
        <Input
          value={description}
          onChange={(event) => onDescriptionChange(event.target.value)}
          placeholder={t(
            "settings.providers.customModelsSection.olderModelViaBedrock",
            "Older model via Bedrock",
          )}
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
  const { t } = useUiTranslation();
  return (
    <div className="space-y-3 rounded-md border border-border p-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <label htmlFor="custom-model-effort" className="text-sm font-medium">
            {t(
              "settings.providers.customModelsSection.supportsThinkingEffort",
              "Supports thinking effort",
            )}
          </label>
          <p className="text-xs text-muted-foreground">
            {t(
              "settings.providers.customModelsSection.showTheThinkingLevelControlWhenThisModel",
              "Show the thinking-level control when this model is selected.",
            )}
          </p>
        </div>
        <Switch id="custom-model-effort" checked={enabled} onCheckedChange={onEnabledChange} />
      </div>
      {enabled ? (
        <div className="space-y-3">
          <div className="space-y-1.5">
            <label className="text-sm font-medium">
              {t(
                "settings.providers.customModelsSection.supportedEffortLevels",
                "Supported effort levels",
              )}
            </label>
            <Input
              className="font-mono text-xs"
              value={levels}
              onChange={(event) => onLevelsChange(event.target.value)}
              placeholder={"low, medium, high, xhigh"}
              aria-invalid={!!error}
            />
            <p className="text-xs text-muted-foreground">
              {t(
                "settings.providers.customModelsSection.commaSeparatedInTheOrderShownByThe",
                "Comma-separated, in the order shown by the thinking selector.",
              )}
            </p>
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium">
              {t(
                "settings.providers.customModelsSection.defaultEffortLevel",
                "Default effort level",
              )}
            </label>
            <Input
              className="font-mono text-xs"
              value={defaultEffort}
              onChange={(event) => onDefaultChange(event.target.value)}
              placeholder={t(
                "settings.providers.customModelsSection.defaultEffortPlaceholder",
                "{{effort}} (optional)",
                { effort: "medium" },
              )}
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

export function validateEffortFields(
  levels: string[],
  defaultEffort: string,
  t: UiTranslator = translateUi,
): string | null {
  if (levels.length === 0)
    return t(
      "settings.providers.customModelsSection.effortRequired",
      "At least one supported effort level is required",
    );
  if (new Set(levels).size !== levels.length)
    return t(
      "settings.providers.customModelsSection.effortUnique",
      "Supported effort levels must be unique",
    );
  if (defaultEffort && !levels.includes(defaultEffort)) {
    return t(
      "settings.providers.customModelsSection.effortUnsupported",
      "Default effort must be one of the supported levels",
    );
  }
  return null;
}

function modelIdError(
  trimmedId: string,
  existingIds: string[],
  isEdit: boolean,
  t: UiTranslator,
): string | null {
  if (!trimmedId)
    return t("settings.providers.customModelsSection.idRequired", "Model ID is required");
  if (!isEdit && existingIds.includes(trimmedId))
    return t(
      "settings.providers.customModelsSection.idTaken",
      "A model with this ID already exists",
    );
  return null;
}

function saveModelToasts(trimmedId: string, onClose: () => void) {
  return toastCallbacks(
    () =>
      translateUi("settings.providers.customModelsSection.saved", 'Custom model "{{name}}" saved', {
        name: trimmedId,
      }),
    () =>
      translateUi(
        "settings.providers.customModelsSection.saveError",
        "Failed to save custom model",
      ),
    onClose,
  );
}
