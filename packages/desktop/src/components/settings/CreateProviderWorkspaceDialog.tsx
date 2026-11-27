import {
  ProviderDialogFooter,
  ProviderDialogHeader,
  ProviderWorkspaceSummary,
  WorkspaceSourceFields,
  type WorkspaceSource,
} from "./ProviderWorkspaceDialogSections";
import { translateUi, useUiTranslation, type UiTranslator } from "@/lib/i18n/ui";
import { useCallback, useId, useState, type FormEvent } from "react";
import { useDialogSubmitShortcut } from "@/components/git-actions/useDialogSubmitShortcut";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { desktopBridge } from "@/lib/desktop-bridge";
import { slugify } from "@/lib/utils";

const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9-]*$/;
const MAX_DISPLAY_NAME_LENGTH = 80;

export interface ProviderWorkspaceDraft {
  providerId: string;
  displayName: string;
  directory?: string;
}

export function CreateProviderWorkspaceDialog({
  isCreating,
  onCreate,
  onClose,
}: {
  isCreating: boolean;
  onCreate: (draft: ProviderWorkspaceDraft) => void;
  onClose: () => void;
}): React.JSX.Element {
  const { t } = useUiTranslation();
  const nameId = useId();
  const providerId = useId();
  const [displayName, setDisplayName] = useState("");
  const [id, setId] = useState("");
  const [editedId, setEditedId] = useState(false);
  const [source, setSource] = useState<WorkspaceSource>("new");
  const [directory, setDirectory] = useState("");
  const [isPickingDirectory, setIsPickingDirectory] = useState(false);
  const [pickerFailed, setPickerFailed] = useState(false);
  const cleanName = displayName.trim();
  const cleanId = id.trim();
  const idError = providerIdError(cleanId, t);
  const cleanDirectory = directory.trim();
  const directoryError = source === "existing" ? providerDirectoryError(cleanDirectory, t) : null;
  const incomplete = cleanName.length === 0 || idError !== null || directoryError !== null;
  const isBusy = isCreating || isPickingDirectory;

  const create = useCallback((): void => {
    if (incomplete || isBusy) return;
    onCreate({
      providerId: cleanId,
      displayName: cleanName,
      ...(source === "existing" ? { directory: cleanDirectory } : {}),
    });
  }, [cleanDirectory, cleanId, cleanName, incomplete, isBusy, onCreate, source]);

  useDialogSubmitShortcut({ open: true, enabled: !incomplete && !isBusy, onSubmit: create });

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    create();
  };

  const updateDisplayName = (value: string): void => {
    setDisplayName(value);
    if (!editedId) setId(slugify(value));
  };

  const pickDirectory = async (): Promise<void> => {
    setIsPickingDirectory(true);
    setPickerFailed(false);
    try {
      const picked = await desktopBridge.pickDirectory();
      if (picked) setDirectory(picked);
    } catch {
      setPickerFailed(true);
    } finally {
      setIsPickingDirectory(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !isBusy && onClose()}>
      <DialogContent className="gap-0 p-0 sm:max-w-xl">
        <ProviderDialogHeader source={source} />

        <form onSubmit={submit} className="space-y-5 px-6 py-5">
          <ProviderIdentityFields
            nameId={nameId}
            providerId={providerId}
            displayName={displayName}
            id={id}
            idError={idError}
            isCreating={isBusy}
            onDisplayNameChange={updateDisplayName}
            onIdChange={(value) => {
              setEditedId(true);
              setId(value);
            }}
          />
          <WorkspaceSourceFields
            source={source}
            directory={directory}
            directoryError={directoryError}
            pickerFailed={pickerFailed}
            isBusy={isBusy}
            onSourceChange={setSource}
            onDirectoryChange={(value) => {
              setDirectory(value);
              setPickerFailed(false);
            }}
            onPickDirectory={() => void pickDirectory()}
          />
          <ProviderWorkspaceSummary source={source} />

          <ProviderDialogFooter
            source={source}
            isCreating={isCreating}
            isPickingDirectory={isPickingDirectory}
            incomplete={incomplete}
            onClose={onClose}
          />
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ProviderIdentityFields({
  nameId,
  providerId,
  displayName,
  id,
  idError,
  isCreating,
  onDisplayNameChange,
  onIdChange,
}: {
  nameId: string;
  providerId: string;
  displayName: string;
  id: string;
  idError: string | null;
  isCreating: boolean;
  onDisplayNameChange: (value: string) => void;
  onIdChange: (value: string) => void;
}): React.JSX.Element {
  const { t } = useUiTranslation();
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <div className="space-y-1.5">
        <label htmlFor={nameId} className="text-xs font-medium">
          {t("settings.providers.createProviderWorkspaceDialog.displayName", "Display name")}
        </label>
        <Input
          id={nameId}
          autoFocus
          value={displayName}
          onChange={(event) => onDisplayNameChange(event.target.value)}
          placeholder="Pi"
          maxLength={MAX_DISPLAY_NAME_LENGTH}
          disabled={isCreating}
        />
      </div>
      <div className="space-y-1.5">
        <label htmlFor={providerId} className="text-xs font-medium">
          {t("settings.providers.createProviderWorkspaceDialog.providerId", "Provider ID")}
        </label>
        <Input
          id={providerId}
          value={id}
          onChange={(event) => onIdChange(event.target.value)}
          placeholder="pi-connector"
          aria-invalid={id.length > 0 && idError !== null}
          aria-describedby={`${providerId}-help`}
          disabled={isCreating}
          className="font-mono"
        />
        <p id={`${providerId}-help`} className="text-[11px] leading-snug text-muted-foreground">
          {id.length > 0 && idError
            ? idError
            : t(
                "settings.providers.createProviderWorkspaceDialog.idHint",
                "Lowercase letters, numbers, and hyphens.",
              )}
        </p>
      </div>
    </div>
  );
}

export function providerIdError(value: string, t: UiTranslator = translateUi): string | null {
  if (value.length === 0)
    return t("settings.providers.createProviderWorkspaceDialog.idRequired", "Enter a provider ID.");
  if (!PROVIDER_ID_PATTERN.test(value)) {
    return t(
      "settings.providers.createProviderWorkspaceDialog.idFormat",
      "Use lowercase letters, numbers, and hyphens; start with a letter.",
    );
  }
  return null;
}

export function providerDirectoryError(
  value: string,
  t: UiTranslator = translateUi,
): string | null {
  if (value.length === 0)
    return t(
      "settings.providers.createProviderWorkspaceDialog.directoryRequired",
      "Choose or enter the connector folder.",
    );
  if (!/^(?:\/|[a-zA-Z]:[\\/]|\\\\)/.test(value))
    return t(
      "settings.providers.createProviderWorkspaceDialog.directoryAbsolute",
      "Enter an absolute folder path.",
    );
  return null;
}
