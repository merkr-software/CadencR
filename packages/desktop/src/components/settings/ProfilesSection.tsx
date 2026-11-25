import { ClaudeProfileEditor } from "./ClaudeProfileEditor";
import { translateUi, UiTrans, useUiTranslation } from "@/lib/i18n/ui";
import { useCallback, useMemo, useState } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { apiErrorMessage } from "@/lib/api-errors";
import { cn } from "@/lib/utils";
import {
  DEFAULT_CLAUDE_PROFILE_NAME,
  useClaudeCodeProfiles,
  useDeleteClaudeCodeProfile,
  useSetActiveClaudeCodeProfile,
  type ClaudeCodeProfile,
} from "@/api/agentRuntime";
import { SettingsHeading } from "./SettingsHeading";
import { ErrorRow, LoadingRow, toastCallbacks } from "./SettingsStateRows";

export function ProfilesSection() {
  const { t } = useUiTranslation();
  const profilesQuery = useClaudeCodeProfiles();
  const [editing, setEditing] = useState<
    { mode: "create" } | { mode: "edit"; profile: ClaudeCodeProfile } | null
  >(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  const profiles = profilesQuery.data?.profiles ?? [];
  const active = profilesQuery.data?.active ?? DEFAULT_CLAUDE_PROFILE_NAME;

  const { activate, remove } = useClaudeProfileActions();

  return (
    <section className="space-y-4">
      <SettingsHeading
        title={t("settings.providers.profilesSection.profiles", "Profiles")}
        description={
          <UiTrans
            i18nKey="settings.providers.profilesSection.profileHelp"
            defaults={
              "Named sets of environment variables applied when spawning the CLI. The <code>{{name}}</code> profile injects nothing."
            }
            components={{ code: <code className="px-1 py-0.5 rounded bg-muted text-xs" /> }}
            values={{ name: DEFAULT_CLAUDE_PROFILE_NAME }}
          />
        }
        action={
          <Button variant="outline" size="sm" onClick={() => setEditing({ mode: "create" })}>
            <Plus className="size-3.5" />{" "}
            {t("settings.providers.profilesSection.newProfile", "New profile")}
          </Button>
        }
      />

      {profilesQuery.isLoading ? (
        <LoadingRow
          label={t("settings.providers.profilesSection.loadingProfiles", "Loading profiles…")}
        />
      ) : profilesQuery.isError ? (
        <ErrorRow label={apiErrorMessage(profilesQuery.error, t("settings.providers.profilesSection.failedToLoadProfiles", "Failed to load profiles."))} />
      ) : (
        <div className="rounded-md border border-border bg-card overflow-hidden">
          <ProfileRow
            name={DEFAULT_CLAUDE_PROFILE_NAME}
            envCount={0}
            isActive={active === DEFAULT_CLAUDE_PROFILE_NAME}
            onActivate={() => activate(DEFAULT_CLAUDE_PROFILE_NAME)}
            isReserved
          />
          {profiles.map((p) => (
            <ProfileRow
              key={p.name}
              name={p.name}
              envCount={Object.keys(p.env).length}
              isActive={active === p.name}
              onActivate={() => activate(p.name)}
              onEdit={() => setEditing({ mode: "edit", profile: p })}
              onDelete={() => setPendingDelete(p.name)}
            />
          ))}
          {profiles.length === 0 && (
            <div className="px-4 py-3 text-sm text-muted-foreground border-t border-border">
              {t(
                "settings.providers.profilesSection.noCustomProfilesYetCreateOneTo",
                "No custom profiles yet. Create one to switch Claude between backends.",
              )}
            </div>
          )}
        </div>
      )}

      {editing && (
        <ClaudeProfileEditor
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
        title={t("settings.providers.profilesSection.deleteTitle", 'Delete profile "{{name}}"?', {
          name: pendingDelete ?? "",
        })}
        description={t(
          "settings.providers.profilesSection.thisCannotBeUndoneTheActiveProfile",
          "This cannot be undone. The active profile will reset to default if you delete it.",
        )}
        confirmText={t("settings.providers.profilesSection.delete", "Delete")}
        variant="destructive"
        onConfirm={() => {
          if (pendingDelete) remove(pendingDelete);
        }}
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
  const { t } = useUiTranslation();
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
          <span className="font-medium text-sm truncate">
            {isReserved ? t("settings.providers.profilesSection.defaultProfile", "default") : name}
          </span>
          {isActive && (
            <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase bg-primary text-primary-foreground">
              {t("settings.providers.profilesSection.active", "Active")}
            </span>
          )}
          {isReserved && (
            <span className="px-1.5 py-0.5 rounded text-[10px] uppercase bg-secondary text-secondary-foreground">
              {t("settings.providers.profilesSection.builtIn", "Built-in")}
            </span>
          )}
        </div>
        <span className="text-xs text-muted-foreground">
          {isReserved
            ? t("settings.providers.profilesSection.noEnv", "No env vars injected")
            : t("settings.providers.profilesSection.envCount", "{{count}} env vars", {
                count: envCount,
                defaultValue_one: "{{count}} env var",
              })}
        </span>
      </div>
      <div className="flex items-center gap-1">
        {!isActive && (
          <Button variant="outline" size="sm" onClick={onActivate}>
            {t("settings.providers.profilesSection.activate", "Activate")}
          </Button>
        )}
        {onEdit && (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onEdit}
            aria-label={t("settings.providers.profilesSection.edit", "Edit {{name}}", { name })}
          >
            <Pencil className="size-3.5" />
          </Button>
        )}
        {onDelete && (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onDelete}
            aria-label={t("settings.providers.profilesSection.remove", "Delete {{name}}", { name })}
            className="text-destructive hover:text-destructive"
          >
            <Trash2 className="size-3.5" />
          </Button>
        )}
      </div>
    </div>
  );
}

function useClaudeProfileActions() {
  const { mutate: setActive } = useSetActiveClaudeCodeProfile();
  const { mutate: deleteProfile } = useDeleteClaudeCodeProfile();
  const activate = useCallback(
    (name: string) =>
      setActive(
        { name },
        toastCallbacks(
          () =>
            translateUi(
              "settings.providers.profilesSection.activated",
              "Active profile: {{name}}",
              {
                name,
              },
            ),
          () =>
            translateUi(
              "settings.providers.profilesSection.activateError",
              "Failed to activate profile",
            ),
        ),
      ),
    [setActive],
  );

  const remove = useCallback(
    (name: string) => {
      deleteProfile(
        { name },
        toastCallbacks(
          () =>
            translateUi(
              "settings.providers.profilesSection.deleted",
              'Profile "{{name}}" deleted',
              {
                name,
              },
            ),
          () =>
            translateUi(
              "settings.providers.profilesSection.deleteError",
              "Failed to delete profile",
            ),
        ),
      );
    },
    [deleteProfile],
  );

  return useMemo(() => ({ activate, remove }), [activate, remove]);
}
