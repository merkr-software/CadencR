import { useMemo, useState, type Dispatch, type ReactElement, type SetStateAction } from "react";
import { Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { cn } from "@/lib/utils";
import {
  DEFAULT_CLAUDE_PROFILE_NAME,
  useClaudeCodeProfiles,
  useDeleteClaudeCodeProfile,
  useSetActiveClaudeCodeProfile,
  useUpsertClaudeCodeProfile,
  type ClaudeCodeProfile,
} from "@/api/agentRuntime";
import { SettingsHeading } from "./SettingsHeading";
import { ErrorRow, LoadingRow, toastCallbacks } from "./SettingsStateRows";

interface EnvRow {
  key: string;
  value: string;
}

interface EnvRowsEditorProps {
  rows: EnvRow[];
  duplicateKey: string | undefined;
  setRows: Dispatch<SetStateAction<EnvRow[]>>;
}

function EnvRowsEditor({ rows, duplicateKey, setRows }: EnvRowsEditorProps): ReactElement {
  const updateRow = (index: number, patch: Partial<EnvRow>): void => {
    setRows((current) =>
      current.map((row, rowIndex) => (rowIndex === index ? { ...row, ...patch } : row)),
    );
  };
  const removeRow = (index: number): void => {
    setRows((current) => {
      const next = current.filter((_, rowIndex) => rowIndex !== index);
      return next.length > 0 ? next : [{ key: "", value: "" }];
    });
  };
  return (
    <div className="space-y-2">
      <label className="text-sm font-medium">Environment variables</label>
      <div className="space-y-1.5">
        {rows.map((row, index) => (
          <div key={index} className="flex items-center gap-2">
            <Input
              className="flex-1 font-mono text-xs"
              placeholder="ANTHROPIC_BASE_URL"
              value={row.key}
              onChange={(event) => updateRow(index, { key: event.target.value })}
            />
            <Input
              className="flex-1 font-mono text-xs"
              placeholder="value"
              value={row.value}
              onChange={(event) => updateRow(index, { value: event.target.value })}
            />
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Remove row"
              onClick={() => removeRow(index)}
            >
              <Trash2 className="size-3.5" />
            </Button>
          </div>
        ))}
      </div>
      {duplicateKey && <p className="text-xs text-destructive">Duplicate key: {duplicateKey}</p>}
      <Button
        variant="outline"
        size="sm"
        onClick={() => setRows((current) => [...current, { key: "", value: "" }])}
      >
        <Plus className="size-3.5" /> Add row
      </Button>
    </div>
  );
}

export function ProfilesSection() {
  const profilesQuery = useClaudeCodeProfiles();
  const setActive = useSetActiveClaudeCodeProfile();
  const deleteProfile = useDeleteClaudeCodeProfile();
  const [editing, setEditing] = useState<
    { mode: "create" } | { mode: "edit"; profile: ClaudeCodeProfile } | null
  >(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  const profiles = profilesQuery.data?.profiles ?? [];
  const active = profilesQuery.data?.active ?? DEFAULT_CLAUDE_PROFILE_NAME;

  const handleActivate = (name: string) =>
    setActive.mutate(
      { name },
      toastCallbacks(`Active profile: ${name}`, "Failed to activate profile"),
    );

  const handleConfirmDelete = () => {
    if (!pendingDelete) return;
    const name = pendingDelete;
    deleteProfile.mutate(
      { name },
      toastCallbacks(`Profile "${name}" deleted`, "Failed to delete profile"),
    );
  };

  return (
    <section className="space-y-4">
      <SettingsHeading
        title="Profiles"
        description={
          <>
            Named sets of environment variables applied when spawning the CLI. The{" "}
            <code className="px-1 py-0.5 rounded bg-muted text-xs">default</code> profile injects
            nothing.
          </>
        }
        action={
          <Button variant="outline" size="sm" onClick={() => setEditing({ mode: "create" })}>
            <Plus className="size-3.5" /> New profile
          </Button>
        }
      />

      {profilesQuery.isLoading ? (
        <LoadingRow label="Loading profiles…" />
      ) : profilesQuery.isError ? (
        <ErrorRow label="Failed to load profiles." />
      ) : (
        <div className="rounded-md border border-border bg-card overflow-hidden">
          <ProfileRow
            name={DEFAULT_CLAUDE_PROFILE_NAME}
            envCount={0}
            isActive={active === DEFAULT_CLAUDE_PROFILE_NAME}
            onActivate={() => handleActivate(DEFAULT_CLAUDE_PROFILE_NAME)}
            isReserved
          />
          {profiles.map((p) => (
            <ProfileRow
              key={p.name}
              name={p.name}
              envCount={Object.keys(p.env).length}
              isActive={active === p.name}
              onActivate={() => handleActivate(p.name)}
              onEdit={() => setEditing({ mode: "edit", profile: p })}
              onDelete={() => setPendingDelete(p.name)}
            />
          ))}
          {profiles.length === 0 && (
            <div className="px-4 py-3 text-sm text-muted-foreground border-t border-border">
              No custom profiles yet. Create one to switch Claude between backends.
            </div>
          )}
        </div>
      )}

      {editing && (
        <ProfileEditor
          initial={editing.mode === "edit" ? editing.profile : undefined}
          existingNames={profiles.map((p) => p.name)}
          onClose={() => setEditing(null)}
        />
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
        title={`Delete profile "${pendingDelete}"?`}
        description="This cannot be undone. The active profile will reset to default if you delete it."
        confirmText="Delete"
        variant="destructive"
        onConfirm={handleConfirmDelete}
      />
    </section>
  );
}

function ProfileRow({
  name,
  envCount,
  isActive,
  onActivate,
  onEdit,
  onDelete,
  isReserved,
}: {
  name: string;
  envCount: number;
  isActive: boolean;
  onActivate: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
  isReserved?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-4 px-4 py-2.5 border-border",
        "first:border-t-0 border-t",
        isActive && "bg-primary/5",
      )}
    >
      <div className="flex flex-col min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-medium text-sm truncate">{name}</span>
          {isActive && (
            <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase bg-primary text-primary-foreground">
              Active
            </span>
          )}
          {isReserved && (
            <span className="px-1.5 py-0.5 rounded text-[10px] uppercase bg-secondary text-secondary-foreground">
              Built-in
            </span>
          )}
        </div>
        <span className="text-xs text-muted-foreground">
          {isReserved ? "No env vars injected" : `${envCount} env var${envCount === 1 ? "" : "s"}`}
        </span>
      </div>
      <div className="flex items-center gap-1">
        {!isActive && (
          <Button variant="outline" size="sm" onClick={onActivate}>
            Activate
          </Button>
        )}
        {onEdit && (
          <Button variant="ghost" size="icon-sm" onClick={onEdit} aria-label={`Edit ${name}`}>
            <Pencil className="size-3.5" />
          </Button>
        )}
        {onDelete && (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onDelete}
            aria-label={`Delete ${name}`}
            className="text-destructive hover:text-destructive"
          >
            <Trash2 className="size-3.5" />
          </Button>
        )}
      </div>
    </div>
  );
}

function ProfileEditor({
  initial,
  existingNames,
  onClose,
}: {
  initial?: ClaudeCodeProfile;
  existingNames: string[];
  onClose: () => void;
}) {
  const upsert = useUpsertClaudeCodeProfile();
  const [name, setName] = useState(initial?.name ?? "");
  const [rows, setRows] = useState<EnvRow[]>(() => {
    if (!initial) return [{ key: "", value: "" }];
    const entries = Object.entries(initial.env);
    return entries.length > 0
      ? entries.map(([key, value]) => ({ key, value }))
      : [{ key: "", value: "" }];
  });

  const isEdit = !!initial;
  const trimmedName = name.trim();
  const nameError = useMemo(() => {
    if (!trimmedName) return "Name is required";
    if (trimmedName.toLowerCase() === DEFAULT_CLAUDE_PROFILE_NAME) return "'default' is reserved";
    if (!isEdit && existingNames.includes(trimmedName))
      return "A profile with this name already exists";
    return null;
  }, [trimmedName, existingNames, isEdit]);

  const seenKeys = new Set<string>();
  const duplicateKey = rows.find((r) => {
    const k = r.key.trim();
    if (!k) return false;
    if (seenKeys.has(k)) return true;
    seenKeys.add(k);
    return false;
  })?.key;

  const canSave = !nameError && !duplicateKey && !upsert.isPending;

  const handleSave = () => {
    if (!canSave) return;
    const env: Record<string, string> = {};
    for (const row of rows) {
      const key = row.key.trim();
      if (!key) continue;
      env[key] = row.value;
    }
    upsert.mutate(
      { name: trimmedName, env },
      toastCallbacks(`Profile "${trimmedName}" saved`, "Failed to save profile", onClose),
    );
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{isEdit ? `Edit profile "${initial!.name}"` : "New profile"}</DialogTitle>
          <DialogDescription>
            Env vars are injected on top of the inherited environment when Claude is spawned.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <label className="text-sm font-medium">Name</label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="bedrock"
              disabled={isEdit}
              aria-invalid={!!nameError}
            />
            {nameError && <p className="text-xs text-destructive">{nameError}</p>}
          </div>
          <EnvRowsEditor rows={rows} duplicateKey={duplicateKey} setRows={setRows} />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!canSave} onClick={handleSave}>
            {upsert.isPending ? <Loader2 className="size-3.5 animate-spin" /> : null}
            Save profile
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
