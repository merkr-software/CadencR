import { formattingLocale } from "@/lib/i18n/formatting-locale";
import { translateUi, useUiTranslation } from "@/lib/i18n/ui";
import { Code2, Copy, Download, Loader2, Trash2 } from "lucide-react";
import type { UserTheme } from "@/api/generated";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { SettingsWarningsBanner } from "@/components/settings/SettingsWarningsBanner";
import { copyToClipboard } from "@/lib/clipboard";
import { themeAppearanceLabel } from "@/lib/themes/display";
import { toThemeDefinition, userThemeLabel } from "@/lib/themes/user-theme";
import { ThemeSwatch } from "./ThemeSwatch";

interface UserThemeCardProps {
  theme: UserTheme;
  isActive: boolean;
  isEnabled: boolean;
  isDeleting: boolean;
  /** Its project is being opened — resolving it can create one. */
  isOpening: boolean;
  onToggleEnabled: (enabled: boolean) => void;
  onEdit: () => void;
  onExport: () => void;
  onDelete: () => void;
}

/**
 * One user theme in the library: preview, on/off, and the four things you can
 * do with a file — edit it, copy where it lives, export it, delete it.
 *
 * An invalid theme still gets a card. Hiding it would leave the user with a
 * theme that vanished and no way to find out why; instead the card shows the
 * issues and the Edit button that fixes them.
 */
export function UserThemeCard({
  theme,
  isActive,
  isEnabled,
  isDeleting,
  isOpening,
  onToggleEnabled,
  onEdit,
  onExport,
  onDelete,
}: UserThemeCardProps): React.JSX.Element {
  const { t, i18n } = useUiTranslation();
  const themeDocument = theme.theme;
  const label = userThemeLabel(theme);
  const switchId = `theme-enabled-${theme.id}`;

  return (
    <div className="space-y-3 rounded-lg border border-border bg-card p-3">
      <div className="flex items-start gap-3">
        <div className="w-20 shrink-0">
          {themeDocument ? (
            <ThemeSwatch theme={toThemeDefinition(theme.id, themeDocument)} />
          ) : (
            <div className="h-9 w-full rounded border border-dashed border-border" aria-hidden />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium">{label}</span>
            {isActive ? (
              <span className="shrink-0 rounded-full bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                {t("appearance.library.active", "Active")}
              </span>
            ) : null}
          </div>
          <p className="truncate text-xs text-muted-foreground">
            {/* The id is the directory name on disk, so it is shown verbatim —
                only the appearance is title-cased. */}
            {themeDocument ? (
              <span className="capitalize">
                {themeAppearanceLabel(themeDocument.appearance, t)}
              </span>
            ) : null}
            {themeDocument ? " · " : null}
            {theme.id}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <label htmlFor={switchId} className="text-xs text-muted-foreground">
            {isEnabled
              ? t("appearance.library.enabled", "Enabled")
              : t("appearance.library.disabled", "Disabled")}
          </label>
          <Switch
            id={switchId}
            checked={isEnabled}
            // A theme that can't be applied can't meaningfully be "on".
            disabled={themeDocument == null}
            onCheckedChange={onToggleEnabled}
          />
        </div>
      </div>

      <SettingsWarningsBanner
        tone="blocking"
        title={t("appearance.library.issueCount", "Not applied: {{count, number}} problems", {
          count: theme.issues.length,
          defaultValue_zero: "Not applied: {{count, number}} problems",
          defaultValue_one: "Not applied: {{count, number}} problem",
          formatParams: { count: { locale: formattingLocale(i18n.language) } },
        })}
        warnings={theme.issues.map((issue) => ({
          key: issue.token ?? "",
          message: issue.token ? `${issue.token}: ${issue.message}` : issue.message,
        }))}
      />

      <CardActions
        path={theme.path}
        isDeleting={isDeleting}
        isOpening={isOpening}
        onEdit={onEdit}
        onExport={onExport}
        onDelete={onDelete}
      />
    </div>
  );
}

/** What you can do with a theme file. */
function CardActions({
  path,
  isDeleting,
  isOpening,
  onEdit,
  onExport,
  onDelete,
}: Pick<UserThemeCardProps, "isDeleting" | "isOpening" | "onEdit" | "onExport" | "onDelete"> & {
  path: string;
}): React.JSX.Element {
  const { t } = useUiTranslation();
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="outline" size="xs" className="gap-1.5" disabled={isOpening} onClick={onEdit}>
        {isOpening ? (
          <Loader2 className="size-3.5 animate-spin" aria-hidden />
        ) : (
          <Code2 className="size-3.5" />
        )}
        {t("appearance.library.edit", "Edit")}
      </Button>
      <Button
        variant="outline"
        size="xs"
        className="gap-1.5"
        onClick={() =>
          void copyToClipboard(
            path,
            translateUi("appearance.library.pathCopied", "Theme path copied"),
          )
        }
      >
        <Copy className="size-3.5" />
        {t("appearance.library.copyPath", "Copy path")}
      </Button>
      <Button variant="outline" size="xs" className="gap-1.5" onClick={onExport}>
        <Download className="size-3.5" />
        {t("appearance.library.export", "Export")}
      </Button>
      <Button
        variant="ghost"
        size="xs"
        className="gap-1.5 text-[var(--acc-red)] hover:text-[var(--acc-red)]"
        disabled={isDeleting}
        onClick={onDelete}
      >
        <Trash2 className="size-3.5" />
        {t("appearance.library.delete", "Delete")}
      </Button>
    </div>
  );
}
