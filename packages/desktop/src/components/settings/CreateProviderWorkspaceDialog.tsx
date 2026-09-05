import { useCallback, useId, useState, type FormEvent } from "react";
import { Loader2 } from "lucide-react";
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
import { slugify } from "@/lib/utils";

const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9-]*$/;
const MAX_DISPLAY_NAME_LENGTH = 80;

export interface ProviderWorkspaceDraft {
  providerId: string;
  displayName: string;
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
  const nameId = useId();
  const providerId = useId();
  const [displayName, setDisplayName] = useState("");
  const [id, setId] = useState("");
  const [editedId, setEditedId] = useState(false);
  const cleanName = displayName.trim();
  const cleanId = id.trim();
  const idError = providerIdError(cleanId);
  const incomplete = cleanName.length === 0 || idError !== null;

  const create = useCallback((): void => {
    if (incomplete || isCreating) return;
    onCreate({ providerId: cleanId, displayName: cleanName });
  }, [cleanId, cleanName, incomplete, isCreating, onCreate]);

  useDialogSubmitShortcut({ open: true, enabled: !incomplete && !isCreating, onSubmit: create });

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    create();
  };

  const updateDisplayName = (value: string): void => {
    setDisplayName(value);
    if (!editedId) setId(slugify(value));
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !isCreating && onClose()}>
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-xl">
        <DialogHeader className="border-b border-border px-6 py-4">
          <DialogTitle className="text-base font-semibold">Add provider</DialogTitle>
          <DialogDescription>
            Create a normal Git-backed Cadencr project where your usual agent can implement a
            complete code-backed provider connector.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="space-y-5 px-6 py-5">
          <ProviderIdentityFields
            nameId={nameId}
            providerId={providerId}
            displayName={displayName}
            id={id}
            idError={idError}
            isCreating={isCreating}
            onDisplayNameChange={updateDisplayName}
            onIdChange={(value) => {
              setEditedId(true);
              setId(value);
            }}
          />
          <ProviderWorkspaceSummary />

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={isCreating}>
              Cancel
            </Button>
            <Button type="submit" disabled={incomplete || isCreating}>
              {isCreating ? <Loader2 className="animate-spin" aria-hidden /> : null}
              {isCreating ? "Creating project…" : "Create provider project"}
            </Button>
          </DialogFooter>
          <p aria-live="polite" className="sr-only">
            {isCreating ? "Creating the provider project and opening its conversation." : ""}
          </p>
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

function ProviderWorkspaceSummary(): React.JSX.Element {
  return (
    <div className="rounded-lg border border-border/60 bg-muted/30 p-3 text-xs text-muted-foreground">
      <p className="font-medium text-foreground">Cadencr creates:</p>
      <ul className="mt-1.5 list-disc space-y-1 pl-4">
        <li>an ordinary project and conversation using your normal workspace layout;</li>
        <li>a Git repository with `README.md` and the complete `INSTRUCTION.md` contract;</li>
        <li>a local descriptor targeting the connector's stable `bin/provider` output.</li>
      </ul>
      <p className="mt-2">
        Restart Cadencr between connector changes before testing. Marketplace publishing and
        third-party installation are not part of this developer flow yet.
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
