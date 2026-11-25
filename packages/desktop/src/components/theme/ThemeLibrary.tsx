import { useUiTranslation } from "@/lib/i18n/ui";
import { useCallback, useState } from "react";
import { Loader2, Plus } from "lucide-react";
import type { UserTheme } from "@/api/generated";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useTheme } from "@/hooks/useTheme";
import { useUserThemes, userThemeLoadError } from "@/hooks/useUserThemes";
import type { ThemeDefinition } from "@/lib/themes";
import { userThemeId, userThemeLabel } from "@/lib/themes/user-theme";
import { CreateThemeDialog } from "./CreateThemeDialog";
import { UserThemeCard } from "./UserThemeCard";
import { useOpenThemeProject } from "./useOpenThemeProject";
import { useReleaseTheme } from "./useReleaseTheme";
import { useThemeLibraryActions } from "./useThemeLibraryActions";

/**
 * The theme library: every theme the user has made, and the one control that
 * makes another.
 *
 * Creating and editing are the same act here — a new theme is a copy of an
 * existing one, opened straight into its own project, where the file, an agent
 * and the diff of what either of them changed all sit together.
 */
export function ThemeLibrary(): React.JSX.Element {
  const { t } = useUiTranslation();
  const { entries, enabledThemes, isLoading, isEnabled, setEnabled, error } = useUserThemes();
  const { themeId } = useTheme();
  const actions = useThemeLibraryActions();
  const { open, openingId } = useOpenThemeProject();
  const release = useReleaseTheme();
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<UserTheme | null>(null);

  const toggleEnabled = useCallback(
    (theme: UserTheme, enabled: boolean): void => {
      setEnabled(theme.id, enabled);
      // A hidden theme can't be worn: keeping it selected would paint the
      // default while the setting still claims otherwise.
      if (!enabled) release(theme);
    },
    [release, setEnabled],
  );

  const createFrom = useCallback(
    (base: ThemeDefinition, label: string): void => {
      actions.duplicate(base, label, (created, workspace) => {
        setCreating(false);
        open(created, workspace);
      });
    },
    [actions, open],
  );

  return (
    <div className="space-y-4">
      <Button size="sm" className="gap-1.5" onClick={() => setCreating(true)}>
        <Plus className="size-3.5" />
        {t("appearance.library.create", "Create theme")}
      </Button>

      {error ? (
        <p className="text-xs text-[var(--acc-red)]">
          {t("appearance.library.loadError", "Could not load your themes: {{error}}", {
            error: userThemeLoadError(error, t),
          })}
        </p>
      ) : null}

      {isLoading ? (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Loader2 className="size-3 animate-spin" aria-hidden />
          {t("appearance.library.loading", "Loading themes…")}
        </p>
      ) : entries.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {t(
            "appearance.library.empty",
            "No themes yet. Create one from any theme you already like. You get its complete, working set of colors to change.",
          )}
        </p>
      ) : (
        <div className="space-y-2">
          {entries.map((entry) => (
            <UserThemeCard
              key={entry.id}
              theme={entry}
              isActive={themeId === userThemeId(entry.id)}
              isEnabled={isEnabled(entry.id)}
              isDeleting={actions.deletingId === entry.id}
              isOpening={openingId === entry.id}
              onToggleEnabled={(enabled) => toggleEnabled(entry, enabled)}
              onEdit={() => open(entry)}
              onExport={() => actions.exportTheme(entry)}
              onDelete={() => setDeleting(entry)}
            />
          ))}
        </div>
      )}

      {creating ? (
        <CreateThemeDialog
          userThemes={enabledThemes}
          isCreating={actions.isDuplicating || openingId !== null}
          onCreate={createFrom}
          onClose={() => setCreating(false)}
        />
      ) : null}

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open_) => !open_ && setDeleting(null)}
        title={
          deleting
            ? t("appearance.library.deleteTitle", "Delete “{{theme}}”?", {
                theme: userThemeLabel(deleting),
              })
            : ""
        }
        description={t(
          "appearance.library.deleteDescription",
          "Its project goes too. The complete theme folder moves to the Trash, including its file and git history.",
        )}
        confirmText={t("appearance.library.delete", "Delete")}
        variant="destructive"
        onConfirm={() => deleting && actions.remove(deleting)}
      />
    </div>
  );
}
