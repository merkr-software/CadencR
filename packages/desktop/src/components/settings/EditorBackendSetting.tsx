import { useGetWorkspaceSetting, usePluginTabList } from "@/api/generated";
import { useSetting } from "@/hooks/useSetting";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useVimModeLevel } from "@/hooks/useVimModeLevel";
import { pluginTabsAvailable } from "@/lib/plugin-tabs/availability";
import {
  EDITOR_BACKEND_KEY,
  pluginEditorUnavailable,
  resolveEditorId,
} from "@/lib/editors/editor-registry";
import { Skeleton } from "@/components/ui/skeleton";
import { RadioCardGroup, type RadioCardOption } from "./RadioCardGroup";

export function EditorBackendSetting() {
  const setting = useSetting(EDITOR_BACKEND_KEY);
  const read = useGetWorkspaceSetting(EDITOR_BACKEND_KEY);
  const vim = useVimModeLevel();
  const desktop = pluginTabsAvailable();
  const mobile = useIsMobile();
  const plugins = usePluginTabList(undefined, { query: { enabled: desktop } });
  const value = resolveEditorId(setting.value, vim);
  const externalUnavailable = !desktop || mobile;
  const options: RadioCardOption<string>[] = [
    { value: "codemirror", label: "CodeMirror", description: "The built-in code editor." },
    {
      value: "neovim",
      label: "Full Neovim",
      description: externalUnavailable
        ? "Requires the desktop app on a supported computer."
        : "The built-in Neovim editor with your own configuration.",
      disabled: externalUnavailable,
    },
    ...(plugins.data ?? [])
      .filter((plugin) => plugin.editor)
      .map((plugin) => {
        const reason = pluginEditorUnavailable(plugin);
        return {
          value: `plugin:${plugin.id}`,
          label: plugin.editor!.label,
          description:
            reason ??
            (externalUnavailable
              ? "Requires the desktop app on a supported computer."
              : `Editor provided by ${plugin.name}.`),
          disabled: externalUnavailable || Boolean(reason),
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
        onChange={(value) => void setting.setValue(value)}
        disabled={setting.isSaving}
      />
    </div>
  );
}
