import { useId } from "react";
import { FolderOpen, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { desktopBridge } from "@/lib/desktop-bridge";
import { useUiTranslation } from "@/lib/i18n/ui";

export type WorkspaceSource = "new" | "existing";

export function ProviderDialogHeader({ source }: { source: WorkspaceSource }): React.JSX.Element {
  const { t } = useUiTranslation();
  return (
    <DialogHeader className="border-b border-border px-6 py-4">
      <DialogTitle className="text-base font-semibold">
        {t("settings.providers.createProviderWorkspaceDialog.addProvider", "Add provider")}
      </DialogTitle>
      <DialogDescription>
        {source === "new"
          ? t(
              "settings.providers.createProviderWorkspaceDialog.createDescription",
              "Create a Git-backed Cadencr project where your usual agent can implement a complete provider connector.",
            )
          : t(
              "settings.providers.createProviderWorkspaceDialog.importDescription",
              "Import an existing Git-backed provider connector as a new Cadencr project without moving its source.",
            )}
      </DialogDescription>
    </DialogHeader>
  );
}

export function ProviderDialogFooter({
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
  const { t } = useUiTranslation();
  const importing = source === "existing";
  return (
    <>
      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          onClick={onClose}
          disabled={isCreating || isPickingDirectory}
        >
          {t("settings.providers.createProviderWorkspaceDialog.cancel", "Cancel")}
        </Button>
        <Button type="submit" disabled={incomplete || isCreating || isPickingDirectory}>
          {isCreating ? <Loader2 className="animate-spin" aria-hidden /> : null}
          {isCreating
            ? importing
              ? t(
                  "settings.providers.createProviderWorkspaceDialog.importing",
                  "Importing project…",
                )
              : t("settings.providers.createProviderWorkspaceDialog.creating", "Creating project…")
            : importing
              ? t(
                  "settings.providers.createProviderWorkspaceDialog.import",
                  "Import provider project",
                )
              : t(
                  "settings.providers.createProviderWorkspaceDialog.create",
                  "Create provider project",
                )}
        </Button>
      </DialogFooter>
      <p aria-live="polite" className="sr-only">
        {isCreating
          ? importing
            ? t(
                "settings.providers.createProviderWorkspaceDialog.importingAndOpening",
                "Importing the provider project and opening its conversation.",
              )
            : t(
                "settings.providers.createProviderWorkspaceDialog.creatingAndOpening",
                "Creating the provider project and opening its conversation.",
              )
          : ""}
      </p>
    </>
  );
}

export function WorkspaceSourceFields({
  source,
  directory,
  directoryError,
  pickerFailed,
  isBusy,
  onSourceChange,
  onDirectoryChange,
  onPickDirectory,
}: {
  source: WorkspaceSource;
  directory: string;
  directoryError: string | null;
  pickerFailed: boolean;
  isBusy: boolean;
  onSourceChange: (source: WorkspaceSource) => void;
  onDirectoryChange: (directory: string) => void;
  onPickDirectory: () => void;
}): React.JSX.Element {
  const { t } = useUiTranslation();
  return (
    <fieldset className="space-y-3" disabled={isBusy}>
      <legend className="text-xs font-medium">
        {t("settings.providers.createProviderWorkspaceDialog.projectSource", "Project source")}
      </legend>
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
                {value === "new"
                  ? t("settings.providers.createProviderWorkspaceDialog.createNew", "Create new")
                  : t(
                      "settings.providers.createProviderWorkspaceDialog.existingFolder",
                      "From existing folder",
                    )}
              </span>
              <span className="mt-0.5 block text-muted-foreground">
                {value === "new"
                  ? t(
                      "settings.providers.createProviderWorkspaceDialog.scaffold",
                      "Scaffold a new connector.",
                    )
                  : t(
                      "settings.providers.createProviderWorkspaceDialog.keepSource",
                      "Keep and use your existing source.",
                    )}
              </span>
            </span>
          </label>
        ))}
      </div>
      {source === "existing" ? (
        <WorkspaceDirectoryField
          directory={directory}
          directoryError={directoryError}
          pickerFailed={pickerFailed}
          isBusy={isBusy}
          onDirectoryChange={onDirectoryChange}
          onPickDirectory={onPickDirectory}
        />
      ) : null}
    </fieldset>
  );
}

export function ProviderWorkspaceSummary({
  source,
}: {
  source: WorkspaceSource;
}): React.JSX.Element {
  const { t } = useUiTranslation();
  return (
    <div className="rounded-lg border border-border/60 bg-muted/30 p-3 text-xs text-muted-foreground">
      <p className="font-medium text-foreground">
        {source === "new"
          ? t("settings.providers.createProviderWorkspaceDialog.creates", "Cadencr creates:")
          : t("settings.providers.createProviderWorkspaceDialog.imports", "Cadencr imports:")}
      </p>
      <ul className="mt-1.5 list-disc space-y-1 pl-4">
        <li>
          {t(
            "settings.providers.createProviderWorkspaceDialog.anOrdinaryProjectAndConversationUsingYour",
            "an ordinary project and conversation using your normal workspace layout;",
          )}
        </li>
        {source === "new" ? (
          <li>
            {t(
              "settings.providers.createProviderWorkspaceDialog.aGitRepositoryWithReadmeMdAndThe",
              "a Git repository with `{{readme}}` and the complete `{{contract}}` contract;",
              { readme: "README.md", contract: "INSTRUCTION.md" },
            )}
          </li>
        ) : (
          <li>
            {t(
              "settings.providers.createProviderWorkspaceDialog.yourExistingGitRepositoryWithoutMovingOr",
              "your existing Git repository without moving or rebuilding it;",
            )}
          </li>
        )}
        <li>
          {t(
            "settings.providers.createProviderWorkspaceDialog.descriptorSummary",
            "a local descriptor targeting the connector's stable `{{binary}}` output.",
            { binary: "bin/provider" },
          )}
        </li>
      </ul>
      {source === "existing" && (
        <p className="mt-2">
          {t(
            "settings.providers.createProviderWorkspaceDialog.importWarning",
            "Only import code you trust: Cadencr runs {{binary}} locally. It must already be built and executable; Cadencr does not build it. A folder that is already a Cadencr project cannot be reclassified.",
            { binary: "bin/provider" },
          )}
        </p>
      )}
      <p className="mt-2">
        {t(
          "settings.providers.createProviderWorkspaceDialog.restart",
          "Restart Cadencr between connector changes before testing.",
        )}
      </p>
    </div>
  );
}

function WorkspaceDirectoryField({
  directory,
  directoryError,
  pickerFailed,
  isBusy,
  onDirectoryChange,
  onPickDirectory,
}: {
  directory: string;
  directoryError: string | null;
  pickerFailed: boolean;
  isBusy: boolean;
  onDirectoryChange: (directory: string) => void;
  onPickDirectory: () => void;
}): React.JSX.Element {
  const { t } = useUiTranslation();
  const directoryId = useId();
  return (
    <div className="space-y-1.5">
      <label htmlFor={directoryId} className="text-xs font-medium">
        {t("settings.providers.createProviderWorkspaceDialog.connectorFolder", "Connector folder")}
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
            {isBusy ? <Loader2 className="animate-spin" aria-hidden /> : <FolderOpen aria-hidden />}
            {t("settings.providers.createProviderWorkspaceDialog.browse", "Browse…")}
          </Button>
        ) : null}
      </div>
      <p id={`${directoryId}-help`} className="text-[11px] leading-snug text-muted-foreground">
        {pickerFailed
          ? t(
              "settings.providers.createProviderWorkspaceDialog.pickerError",
              "Could not open the folder picker. Enter the folder path manually.",
            )
          : directory.length > 0 && directoryError
            ? directoryError
            : t(
                "settings.providers.createProviderWorkspaceDialog.repositoryHint",
                "Select a Git repository that already contains an executable {{binary}}.",
                { binary: "bin/provider" },
              )}
      </p>
    </div>
  );
}
