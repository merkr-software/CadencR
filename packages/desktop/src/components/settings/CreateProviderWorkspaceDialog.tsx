import { useCallback, useId, useState, type FormEvent } from "react";
import { FolderOpen, Loader2 } from "lucide-react";
import { useDialogSubmitShortcut } from "@/components/git-actions/useDialogSubmitShortcut";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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

type WorkspaceSource = "new" | "existing";

export function CreateProviderWorkspaceDialog({
  isCreating,
  onCreate,
  onClose,
}: {
  isCreating: boolean;
  onCreate: (draft: ProviderWorkspaceDraft) => void;
  onClose: () => void;
}): React.JSX.Element {
  const nameId = useId();
  const providerId = useId();
  const [displayName, setDisplayName] = useState("");
  const [id, setId] = useState("");
  const [editedId, setEditedId] = useState(false);
  const [source, setSource] = useState<WorkspaceSource>("new");
  const [directory, setDirectory] = useState("");
  const [isPickingDirectory, setIsPickingDirectory] = useState(false);
  const [pickerError, setPickerError] = useState<string | null>(null);
  const cleanName = displayName.trim();
  const cleanId = id.trim();
  const idError = providerIdError(cleanId);
  const cleanDirectory = directory.trim();
  const directoryError = source === "existing" ? providerDirectoryError(cleanDirectory) : null;
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
    setPickerError(null);
    try {
      const picked = await desktopBridge.pickDirectory();
      if (picked) setDirectory(picked);
    } catch {
      setPickerError("Could not open the folder picker. Enter the folder path manually.");
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
            pickerError={pickerError}
            isBusy={isBusy}
            onSourceChange={setSource}
            onDirectoryChange={(value) => {
              setDirectory(value);
              setPickerError(null);
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

function ProviderDialogHeader({ source }: { source: WorkspaceSource }): React.JSX.Element {
  return (
    <DialogHeader className="border-b border-border px-6 py-4">
      <DialogTitle className="text-base font-semibold">Add provider</DialogTitle>
      <DialogDescription>
        {source === "new"
          ? "Create a Git-backed Cadencr project where your usual agent can implement a complete provider connector."
          : "Import an existing Git-backed provider connector as a new Cadencr project without moving its source."}
      </DialogDescription>
    </DialogHeader>
  );
}

function ProviderDialogFooter({
  source,
  isCreating,
  isPickingDirectory,
  incomplete,
  onClose,
}: {
  source: WorkspaceSource;
  isCreating: boolean;
  isPickingDirectory: boolean;
  incomplete: boolean;
  onClose: () => void;
}): React.JSX.Element {
  const action = source === "existing" ? "Import" : "Create";
  return (
    <>
      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          onClick={onClose}
          disabled={isCreating || isPickingDirectory}
        >
          Cancel
        </Button>
        <Button type="submit" disabled={incomplete || isCreating || isPickingDirectory}>
          {isCreating ? <Loader2 className="animate-spin" aria-hidden /> : null}
          {isCreating
            ? `${action === "Import" ? "Importing" : "Creating"} project…`
            : `${action} provider project`}
        </Button>
      </DialogFooter>
      <p aria-live="polite" className="sr-only">
        {isCreating
          ? `${action === "Import" ? "Importing" : "Creating"} the provider project and opening its conversation.`
          : ""}
      </p>
    </>
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
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <div className="space-y-1.5">
        <label htmlFor={nameId} className="text-xs font-medium">
          Display name
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
          Provider ID
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
          {id.length > 0 && idError ? idError : "Lowercase letters, numbers, and hyphens."}
        </p>
      </div>
    </div>
  );
}

function WorkspaceSourceFields({
  source,
  directory,
  directoryError,
  pickerError,
  isBusy,
  onSourceChange,
  onDirectoryChange,
  onPickDirectory,
}: {
  source: WorkspaceSource;
  directory: string;
  directoryError: string | null;
  pickerError: string | null;
  isBusy: boolean;
  onSourceChange: (source: WorkspaceSource) => void;
  onDirectoryChange: (directory: string) => void;
  onPickDirectory: () => void;
}): React.JSX.Element {
  const directoryId = useId();
  return (
    <fieldset className="space-y-3" disabled={isBusy}>
      <legend className="text-xs font-medium">Project source</legend>
      <div className="grid gap-2 sm:grid-cols-2">
        {(["new", "existing"] as const).map((value) => (
          <label
            key={value}
            className="flex cursor-pointer items-start gap-2 rounded-lg border border-border/60 p-3 text-xs has-[:checked]:border-primary has-[:checked]:bg-primary/5"
          >
            <input
              type="radio"
              name="workspace-source"
              value={value}
              checked={source === value}
              onChange={() => onSourceChange(value)}
              className="mt-0.5 accent-primary"
            />
            <span>
              <span className="block font-medium text-foreground">
                {value === "new" ? "Create new" : "From existing folder"}
              </span>
              <span className="mt-0.5 block text-muted-foreground">
                {value === "new"
                  ? "Scaffold a new connector."
                  : "Keep and use your existing source."}
              </span>
            </span>
          </label>
        ))}
      </div>
      {source === "existing" ? (
        <div className="space-y-1.5">
          <label htmlFor={directoryId} className="text-xs font-medium">
            Connector folder
          </label>
          <div className="flex gap-2">
            <Input
              id={directoryId}
              value={directory}
              onChange={(event) => onDirectoryChange(event.target.value)}
              placeholder="/path/to/provider-connector"
              aria-invalid={directory.length > 0 && directoryError !== null}
              aria-describedby={`${directoryId}-help`}
              className="font-mono"
            />
            {desktopBridge.isElectron ? (
              <Button type="button" variant="outline" onClick={onPickDirectory} disabled={isBusy}>
                {isBusy ? (
                  <Loader2 className="animate-spin" aria-hidden />
                ) : (
                  <FolderOpen aria-hidden />
                )}
                Browse…
              </Button>
            ) : null}
          </div>
          <p id={`${directoryId}-help`} className="text-[11px] leading-snug text-muted-foreground">
            {pickerError ??
              (directory.length > 0 && directoryError
                ? directoryError
                : "Select a Git repository that already contains an executable bin/provider.")}
          </p>
        </div>
      ) : null}
    </fieldset>
  );
}

function ProviderWorkspaceSummary({ source }: { source: WorkspaceSource }): React.JSX.Element {
  return (
    <div className="rounded-lg border border-border/60 bg-muted/30 p-3 text-xs text-muted-foreground">
      <p className="font-medium text-foreground">
        {source === "new" ? "Cadencr creates:" : "Cadencr imports:"}
      </p>
      <ul className="mt-1.5 list-disc space-y-1 pl-4">
        <li>an ordinary project and conversation using your normal workspace layout;</li>
        {source === "new" ? (
          <li>a Git repository with `README.md` and the complete `INSTRUCTION.md` contract;</li>
        ) : (
          <li>your existing Git repository without moving or rebuilding it;</li>
        )}
        <li>a local descriptor targeting the connector&apos;s stable `bin/provider` output.</li>
      </ul>
      <p className="mt-2">
        {source === "existing"
          ? "Only import code you trust: Cadencr runs bin/provider locally. It must already be built and executable; Cadencr does not build it. A folder that is already a Cadencr project cannot be reclassified. "
          : ""}
        Restart Cadencr between connector changes before testing.
      </p>
    </div>
  );
}

export function providerIdError(value: string): string | null {
  if (value.length === 0) return "Enter a provider ID.";
  if (!PROVIDER_ID_PATTERN.test(value)) {
    return "Use lowercase letters, numbers, and hyphens; start with a letter.";
  }
  return null;
}

export function providerDirectoryError(value: string): string | null {
  if (value.length === 0) return "Choose or enter the connector folder.";
  if (!/^(?:\/|[a-zA-Z]:[\\/]|\\\\)/.test(value)) return "Enter an absolute folder path.";
  return null;
}
