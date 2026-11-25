import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetWorkspaceSettingQueryKey,
  getMigrationStatusRouteQueryKey,
  useGetWorkspaceSetting,
  useMigrateToPluginRoute,
  usePluginTabList,
  useMigrationStatusRoute,
} from "@/api/generated";
import { useSetting, type SettingWriter } from "@/hooks/useSetting";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useVimModeLevel } from "@/hooks/useVimModeLevel";
import { pluginTabsAvailable } from "@/lib/plugin-tabs/availability";
import { toastError } from "@/lib/api-errors";
import {
  EDITOR_BACKEND_KEY,
  pluginEditorUnavailable,
  resolveEditorId,
} from "@/lib/editors/editor-registry";
import { Skeleton } from "@/components/ui/skeleton";
import { RadioCardGroup, type RadioCardOption } from "./RadioCardGroup";

/** The `editor_backend` value the guarded migration route writes. */
const NEOVIM_PLUGIN_EDITOR_ID = "plugin:neovim";

/**
 * Writes the editor choice. `plugin:neovim` goes through the migration route,
 * the guarded path: it refuses while a built-in Neovim session is still alive,
 * so the switch cannot hide live buffers.
 */
function useEditorBackendWriter(setValue: SettingWriter["setValue"]) {
  const queryClient = useQueryClient();
  const migrate = useMigrateToPluginRoute();
  const select = useCallback(
    async (next: string): Promise<void> => {
      if (next !== NEOVIM_PLUGIN_EDITOR_ID) {
        await setValue(next);
        return;
      }
      try {
        await migrate.mutateAsync();
        await Promise.all([
          queryClient.invalidateQueries({
            queryKey: getGetWorkspaceSettingQueryKey(EDITOR_BACKEND_KEY),
          }),
          queryClient.invalidateQueries({ queryKey: getMigrationStatusRouteQueryKey() }),
        ]);
      } catch (error) {
        toastError(error, "The editor could not be switched");
      }
    },
    [migrate, queryClient, setValue],
  );
  return { select, switching: migrate.isPending };
}

export function EditorBackendSetting() {
  const setting = useSetting(EDITOR_BACKEND_KEY);
  const read = useGetWorkspaceSetting(EDITOR_BACKEND_KEY);
  const vim = useVimModeLevel();
  const desktop = pluginTabsAvailable();
  const mobile = useIsMobile();
  const plugins = usePluginTabList(undefined, { query: { enabled: desktop } });
  const value = resolveEditorId(setting.value, vim);
  const externalUnavailable = !desktop || mobile;
  // Guard the plugin:neovim choice behind the same live-session check the
  // migration panel uses, so switching cannot hide running built-in buffers.
  const migration = useMigrationStatusRoute({
    query: { enabled: value === "neovim" && desktop },
  });
  const { select, switching } = useEditorBackendWriter(setting.setValue);
  const sessionsRunning = migration.data?.sessions_running.length ?? 0;
  const options: RadioCardOption<string>[] = [
    { value: "codemirror", label: "CodeMirror", description: "The built-in code editor." },
    {
      value: "neovim",
      label: "Full Neovim",
      description: mobile
        ? "Unavailable on mobile."
        : "The built-in Neovim editor with your own configuration.",
      disabled: mobile,
    },
    ...(plugins.data ?? [])
      .filter((plugin) => plugin.editor)
      .map((plugin) => {
        const reason = pluginEditorUnavailable(plugin);
        const blockedBySessions =
          plugin.id === "neovim" && sessionsRunning > 0
            ? `${sessionsRunning} full Neovim session${sessionsRunning === 1 ? "" : "s"} still running. Save and quit first.`
            : null;
        return {
          value: `plugin:${plugin.id}`,
          label: plugin.editor!.label,
          description:
            blockedBySessions ??
            reason ??
            (externalUnavailable
              ? "Requires the desktop app on a supported computer."
              : `Editor provided by ${plugin.name}.`),
          disabled: externalUnavailable || Boolean(reason) || blockedBySessions !== null,
        };
      }),
  ];
  if (!options.some((option) => option.value === value))
    options.push({
      value,
      label: value,
      description: "This editor is unavailable. Choose another editor.",
      disabled: true,
    });
  if (setting.isLoading)
    return <Skeleton aria-label="Loading editor choices" className="h-16 w-full" />;
  return (
    <div className="space-y-3">
      <div className="space-y-0.5">
        <div className="text-sm font-medium">Editor</div>
        <p className="text-xs text-muted-foreground">
          Open files with the built-in editor or an enabled editor plugin.
        </p>
      </div>
      {plugins.isLoading && (
        <p role="status" className="text-xs text-muted-foreground">
          Loading editor plugins…
        </p>
      )}
      {plugins.isError && (
        <p role="alert" className="text-xs text-destructive">
          Editor plugins could not be loaded.
        </p>
      )}
      {read.isError && (
        <p role="alert" className="text-xs text-destructive">
          The editor choice could not be loaded.
        </p>
      )}
      {setting.isSaving && (
        <p role="status" className="text-xs text-muted-foreground">
          Saving editor choice…
        </p>
      )}
      <RadioCardGroup
        ariaLabel="Editor backend"
        value={value}
        options={options}
        onChange={(next) => void select(next)}
        disabled={setting.isSaving || switching}
      />
    </div>
  );
}
