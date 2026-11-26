import { useState } from "react";
import { Loader2, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  useCodexProfiles,
  useDeleteCodexProfile,
  useSetActiveCodexProfile,
  type CodexProfileSummary,
} from "@/api/codexProfiles";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { apiErrorMessage } from "@/lib/api-errors";
import { CodexProfileEditor } from "./CodexProfileEditor";
import { SettingsHeading } from "./SettingsHeading";
import { ErrorRow, LoadingRow } from "./SettingsStateRows";

export function CodexProfilesSection(): React.JSX.Element {
  const query = useCodexProfiles();
  const activate = useSetActiveCodexProfile();
  const remove = useDeleteCodexProfile();
  const [editing, setEditing] = useState<CodexProfileSummary | "new" | null>(null);
  const [pendingDelete, setPendingDelete] = useState<CodexProfileSummary | null>(null);
  const [activatingId, setActivatingId] = useState<string | null>(null);

  const setDefault = (id: string | null): void => {
    setActivatingId(id ?? "native");
    activate.mutate(id, {
      onSuccess: () => toast.success("Default Codex profile updated"),
      onError: (error) =>
        toast.error(apiErrorMessage(error, "Failed to update the default Codex profile")),
      onSettled: () => setActivatingId(null),
    });
  };
  const confirmDelete = async (): Promise<boolean | void> => {
    if (!pendingDelete) return;
    try {
      await remove.mutateAsync(pendingDelete.id);
      toast.success(`Profile “${pendingDelete.name}” deleted`);
    } catch (error) {
      toast.error(apiErrorMessage(error, "Failed to delete the Codex profile"));
      return false;
    }
  };

  return (
    <section className="space-y-4">
      <SettingsHeading
        title="Profiles"
        description="Named Codex configurations and environment variables. Profiles without a custom config.toml use your usual Codex home."
        action={
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={query.isFetching}
              onClick={() => void query.refetch()}
            >
              <RefreshCw className="size-3.5" aria-hidden /> Refresh profile status
            </Button>
            <Button variant="outline" size="sm" onClick={() => setEditing("new")}>
              <Plus className="size-3.5" /> New profile
            </Button>
          </div>
        }
      />
      {query.isLoading ? (
        <LoadingRow label="Loading Codex profiles…" />
      ) : query.isError ? (
        <ErrorRow label={apiErrorMessage(query.error, "Failed to load Codex profiles.")} />
      ) : (
        <div className="overflow-hidden rounded-md border border-border bg-card">
          <NativeProfileRow
            isActive={query.data?.active_profile_id == null}
            activating={activate.isPending}
            showSpinner={activatingId === "native"}
            onActivate={() => setDefault(null)}
          />
          {(query.data?.profiles ?? []).map((profile) => (
            <CodexProfileRow
              key={profile.id}
              profile={profile}
              activating={activate.isPending}
              showSpinner={activatingId === profile.id}
              onActivate={() => setDefault(profile.id)}
              onEdit={() => setEditing(profile)}
              onDelete={() => setPendingDelete(profile)}
            />
          ))}
          {query.data?.profiles.length === 0 && (
            <p className="border-t border-border px-4 py-3 text-sm text-muted-foreground">
              No custom profiles yet. Create one for a different Codex configuration.
            </p>
          )}
        </div>
      )}
      {editing && (
        <CodexProfileEditor
          initial={editing === "new" ? undefined : editing}
          onClose={() => setEditing(null)}
        />
      )}
      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
        title={`Delete profile “${pendingDelete?.name ?? ""}”?`}
        description="This removes Cadencr’s profile definition, but never writes to or deletes the source config.toml or profile home."
        confirmText="Delete"
        variant="destructive"
        busy={remove.isPending}
        onConfirm={confirmDelete}
      />
    </section>
  );
}

function NativeProfileRow({
  isActive,
  activating,
  showSpinner,
  onActivate,
}: {
  isActive: boolean;
  activating: boolean;
  showSpinner: boolean;
  onActivate: () => void;
}): React.JSX.Element {
  return (
    <div
      className={`flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-2.5 ${isActive ? "bg-primary/5" : ""}`}
    >
      <div className="flex min-w-0 flex-1 basis-40 flex-col">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">default</span>
          {isActive && <ProfileBadge>Active</ProfileBadge>}
          <span className="rounded bg-secondary px-1.5 py-0.5 text-[10px] uppercase text-secondary-foreground">
            Built-in
          </span>
        </div>
        <span className="text-xs text-muted-foreground">Uses your usual Codex configuration</span>
      </div>
      {!isActive && (
        <div className="ml-auto shrink-0">
          <Button
            variant="outline"
            size="sm"
            disabled={activating}
            aria-busy={showSpinner}
            onClick={onActivate}
          >
            {showSpinner && <Loader2 className="size-3.5 animate-spin" />}Activate
          </Button>
        </div>
      )}
    </div>
  );
}

function ProfileBadge({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <span className="rounded bg-primary px-1.5 py-0.5 text-[10px] font-semibold uppercase text-primary-foreground">
      {children}
    </span>
  );
}

function CodexProfileRow({
  profile,
  activating,
  showSpinner,
  onActivate,
  onEdit,
  onDelete,
}: {
  profile: CodexProfileSummary;
  activating: boolean;
  showSpinner: boolean;
  onActivate: () => void;
  onEdit: () => void;
  onDelete: () => void;
}): React.JSX.Element {
  const invalidConfig = profile.revision === "invalid";
  return (
    <div
      className={`flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-border px-4 py-2.5 ${profile.is_active ? "bg-primary/5" : ""}`}
    >
      <div className="min-w-0 flex-1 basis-40 space-y-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{profile.name}</span>
          {profile.is_active && <ProfileBadge>Active</ProfileBadge>}
        </div>
        <p
          className="truncate font-mono text-xs text-muted-foreground"
          title={profile.effective_home ?? "Uses the normal Codex home"}
        >
          {profile.config_path && profile.effective_home
            ? `CODEX_HOME=${profile.effective_home}`
            : "Uses usual Codex configuration"}
        </p>
        <p className="text-xs text-muted-foreground">
          {profile.env_keys.length} env var{profile.env_keys.length === 1 ? "" : "s"}
          {profile.env_unset.length > 0 &&
            ` · ${profile.env_unset.length} removed inherited variable${profile.env_unset.length === 1 ? "" : "s"}`}
        </p>
        {invalidConfig && (
          <p className="text-xs text-destructive">
            Profile unavailable. Repair or replace its config.toml to use it.
          </p>
        )}
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-1">
        {!profile.is_active && (
          <Button
            variant="outline"
            size="sm"
            disabled={activating}
            aria-busy={showSpinner}
            onClick={onActivate}
          >
            {showSpinner && <Loader2 className="size-3.5 animate-spin" />}Activate
          </Button>
        )}
        <Button variant="ghost" size="icon-sm" aria-label={`Edit ${profile.name}`} onClick={onEdit}>
          <Pencil className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          className="text-destructive hover:text-destructive"
          aria-label={`Delete ${profile.name}`}
          onClick={onDelete}
        >
          <Trash2 className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}
