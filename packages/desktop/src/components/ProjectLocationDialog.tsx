import { reportProjectUpdate } from "./project-location-report";
import { translateUi, useUiTranslation } from "@/lib/i18n/ui";
import { useCallback, useId, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { FolderOpen, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useUpdateProject } from "@/api/generated";
import { useDialogSubmitShortcut } from "@/components/git-actions/useDialogSubmitShortcut";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { apiErrorMessage } from "@/lib/api-errors";
import { desktopBridge, isDesktopShell } from "@/lib/desktop-bridge";
import {
  destinationOf,
  draftError,
  folderName,
  folderNameFor,
  parentFolder,
  updateRequestFor,
  type ProjectLocationDraft,
  type ProjectLocationMode,
} from "@/lib/project-location";

export interface ProjectLocationTarget {
  id: number;
  name: string;
  path: string;
  /** The folder is not where the project records it: only the name can change. */
  folderMissing: boolean;
  mode: ProjectLocationMode;
}

function useLocationCopy(mode: ProjectLocationMode) {
  const { t } = useUiTranslation();
  switch (mode) {
    case "rename":
      return {
        title: t("project.location.renameTitle", "Rename project"),
        action: t("common.rename", "Rename"),
        busy: t("project.location.renaming", "Renaming…"),
      };
    case "move":
      return {
        title: t("project.location.moveTitle", "Move project folder"),
        action: t("common.move", "Move"),
        busy: t("project.location.moving", "Moving…"),
      };
    case "locate":
      return {
        title: t("project.location.locateTitle", "Locate project folder"),
        action: t("project.location.useFolder", "Use this folder"),
        busy: t("project.location.locating", "Locating…"),
      };
  }
}

function initialDraft(target: ProjectLocationTarget): ProjectLocationDraft {
  return {
    mode: target.mode,
    name: target.name,
    renameFolder: !target.folderMissing,
    folderName: folderName(target.path),
    parent: parentFolder(target.path),
    locatedPath: "",
  };
}

export function ProjectLocationDialog({
  target,
  onClose,
}: {
  target: ProjectLocationTarget;
  onClose: () => void;
}) {
  const { t } = useUiTranslation();
  const [draft, setDraft] = useState(() => initialDraft(target));
  const [folderEdited, setFolderEdited] = useState(false);
  const update = useProjectUpdate(onClose);
  const request = updateRequestFor(target, draft);
  const blocked = draftError(draft);
  const canSubmit = blocked === null && request !== null && !update.isPending;

  const submit = useCallback(() => {
    if (!canSubmit || request === null) return;
    update.mutate({ id: target.id, data: request });
  }, [canSubmit, request, target.id, update]);
  useDialogSubmitShortcut({ open: true, enabled: canSubmit, onSubmit: submit });

  const change = (patch: Partial<ProjectLocationDraft>) => {
    update.reset();
    setDraft((current) => ({ ...current, ...patch }));
  };
  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    submit();
  };
  const copy = useLocationCopy(target.mode);
  const destination = destinationOf(target, draft);

  return (
    <Dialog open onOpenChange={(open) => !open && !update.isPending && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription>{describe(target)}</DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          {target.mode === "rename" ? (
            <RenameFields
              draft={draft}
              folderMissing={target.folderMissing}
              disabled={update.isPending}
              onNameChange={(name) =>
                change(folderEdited ? { name } : { name, folderName: folderNameFor(name) })
              }
              onRenameFolderChange={(renameFolder) => change({ renameFolder })}
              onFolderNameChange={(value) => {
                setFolderEdited(true);
                change({ folderName: value });
              }}
            />
          ) : target.mode === "move" ? (
            <MoveFields draft={draft} disabled={update.isPending} onChange={change} />
          ) : (
            <FolderPathField
              label={t("project.location.folder", "Folder")}
              value={draft.locatedPath}
              disabled={update.isPending}
              onChange={(locatedPath) => change({ locatedPath })}
            />
          )}
          <DestinationPreview destination={destination} />
          <FormMessage
            error={
              update.error
                ? apiErrorMessage(update.error, translateUi("common.unknownError", "Unknown error"))
                : null
            }
          />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={update.isPending}>
              {t("common.cancel", "Cancel")}
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {update.isPending ? <Loader2 className="animate-spin" aria-hidden /> : null}
              {update.isPending ? copy.busy : copy.action}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function describe(target: ProjectLocationTarget): string {
  switch (target.mode) {
    case "rename":
      return translateUi(
        "project.location.renameDescription",
        "The project's conversations and git worktrees follow a renamed folder, and so does the agents' own state wherever Cadencr can carry it.",
      );
    case "move":
      return translateUi(
        "project.location.moveDescription",
        "The project's conversations and git worktrees follow the folder, and so does the agents' own state wherever Cadencr can carry it. Moving to another disk copies the folder and leaves the original in place.",
      );
    case "locate":
      return translateUi(
        "project.location.locateDescription",
        "The folder is no longer at {{path}}. Point the project at where it is now; nothing is moved.",
        { path: target.path },
      );
  }
}

function useProjectUpdate(onClose: () => void) {
  const queryClient = useQueryClient();
  return useUpdateProject({
    mutation: {
      onSuccess: (response) => {
        // The folder is in every path the app shows: refetch them all.
        void queryClient.invalidateQueries();
        reportProjectUpdate(response);
        onClose();
      },
    },
  });
}

function RenameFields({
  draft,
  folderMissing,
  disabled,
  onNameChange,
  onRenameFolderChange,
  onFolderNameChange,
}: {
  draft: ProjectLocationDraft;
  folderMissing: boolean;
  disabled: boolean;
  onNameChange: (name: string) => void;
  onRenameFolderChange: (renameFolder: boolean) => void;
  onFolderNameChange: (folderName: string) => void;
}) {
  const { t } = useUiTranslation();
  const nameId = useId();
  const folderId = useId();
  const checkboxId = useId();
  return (
    <>
      <Field id={nameId} label={t("project.location.name", "Name")}>
        <Input
          id={nameId}
          autoFocus
          value={draft.name}
          disabled={disabled}
          onChange={(event) => onNameChange(event.target.value)}
        />
      </Field>
      {folderMissing ? (
        <p className="text-sm text-muted-foreground">
          {t(
            "project.location.missingFolderRenameHint",
            "The folder is no longer at its recorded place, so only the name changes. Locate the folder from the project menu first to rename it too.",
          )}
        </p>
      ) : (
        <FolderRenameToggle
          id={checkboxId}
          checked={draft.renameFolder}
          disabled={disabled}
          onChange={onRenameFolderChange}
        />
      )}
      {draft.renameFolder ? (
        <Field id={folderId} label={t("project.location.folderName", "Folder name")}>
          <Input
            id={folderId}
            value={draft.folderName}
            disabled={disabled}
            onChange={(event) => onFolderNameChange(event.target.value)}
          />
        </Field>
      ) : null}
    </>
  );
}

function FolderRenameToggle({
  id,
  checked,
  disabled,
  onChange,
}: {
  id: string;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) {
  const { t } = useUiTranslation();
  return (
    <label htmlFor={id} className="flex items-center gap-2 text-sm">
      <Checkbox
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={(value) => onChange(value === true)}
      />
      {t("project.location.renameFolder", "Also rename the folder")}
    </label>
  );
}

function MoveFields({
  draft,
  disabled,
  onChange,
}: {
  draft: ProjectLocationDraft;
  disabled: boolean;
  onChange: (patch: Partial<ProjectLocationDraft>) => void;
}) {
  const { t } = useUiTranslation();
  const folderId = useId();
  return (
    <>
      <FolderPathField
        label={t("project.location.moveInto", "Move into")}
        value={draft.parent}
        disabled={disabled}
        onChange={(parent) => onChange({ parent })}
      />
      <Field id={folderId} label={t("project.location.folderName", "Folder name")}>
        <Input
          id={folderId}
          value={draft.folderName}
          disabled={disabled}
          onChange={(event) => onChange({ folderName: event.target.value })}
        />
      </Field>
    </>
  );
}

function FolderPathField({
  label,
  value,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  disabled: boolean;
  onChange: (path: string) => void;
}) {
  const { t } = useUiTranslation();
  const id = useId();
  const [picking, setPicking] = useState(false);
  const pick = async () => {
    setPicking(true);
    try {
      const picked = await desktopBridge.pickDirectory();
      if (picked) onChange(picked);
    } catch (error) {
      toast.error(
        translateUi(
          "project.location.folderPickerFailed",
          "Could not open the folder picker: {{error}}",
          { error: apiErrorMessage(error, translateUi("common.unknownError", "Unknown error")) },
        ),
      );
    } finally {
      setPicking(false);
    }
  };
  return (
    <Field id={id} label={label}>
      <div className="flex gap-2">
        <Input
          id={id}
          value={value}
          placeholder="/path/to/folder"
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        />
        {isDesktopShell() ? (
          <Button
            type="button"
            variant="outline"
            disabled={disabled || picking}
            onClick={() => void pick()}
          >
            {picking ? (
              <Loader2 className="animate-spin" aria-hidden />
            ) : (
              <FolderOpen aria-hidden />
            )}
            {t("common.browse", "Browse")}
          </Button>
        ) : null}
      </div>
    </Field>
  );
}

function Field({ id, label, children }: { id: string; label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      {children}
    </div>
  );
}

function DestinationPreview({ destination }: { destination: string | null }) {
  const { t } = useUiTranslation();
  if (!destination) return null;
  return (
    <p className="flex min-w-0 gap-1 text-xs text-muted-foreground" title={destination}>
      <span className="shrink-0">{t("project.location.folderLabel", "Folder:")}</span>
      {/* Elide the start: the folder's own name is the part worth reading. */}
      <span dir="rtl" className="min-w-0 truncate text-left font-mono">
        <span dir="ltr">{destination}</span>
      </span>
    </p>
  );
}

function FormMessage({ error }: { error: string | null }) {
  if (error === null) return null;
  return (
    <p role="alert" className="text-sm text-destructive">
      {error}
    </p>
  );
}
