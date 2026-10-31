import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useDebouncedSetting } from "@/hooks/useDebouncedSetting";
import { parseVimModeLevel, type VimModeLevel } from "@/lib/vim-mode-level";
import { FileTreeIconSetSelector } from "./FileTreeIconSetSelector";
import { LspServerList } from "./LspServerList";
import { RadioCardGroup, type RadioCardOption } from "./RadioCardGroup";
import { SettingsGroup } from "./SettingsGroup";
import { SettingsRow } from "./SettingsRow";
import { SettingsPageSection } from "./SettingsPageSection";
import { SettingsSubsection } from "./SettingsSubsection";
import { SettingsSwitchRow } from "./SettingsSwitchRow";
import { SETTINGS_ANCHORS } from "./settings-anchor-ids";

const VIM_MODE_LEVEL_OPTIONS: RadioCardOption<VimModeLevel>[] = [
  { value: "0", label: "Off", description: "Standard editing, no vim motions." },
  {
    value: "1",
    label: "Vim motion",
    description: "Modal editing via the built-in vim emulation.",
  },
  {
    value: "2",
    label: "Full Neovim",
    description:
      "A real Neovim instance with your own config, plugins and UI, rendered in the editor panel.",
  },
];

/** Settings → Editor: the built-in code editor, its language servers and file tree. */
export function EditorPage(): React.JSX.Element {
  const vimModeLevel = useDebouncedSetting("editor_vim_mode_level");
  const autoSave = useDebouncedSetting("editor_auto_save");
  const gitBlame = useDebouncedSetting("editor_git_blame");

  return (
    <SettingsPageSection pageId="editor">
      <SettingsGroup id={SETTINGS_ANCHORS.editing} title="Editing">
        <SettingsSubsection>
          <div className="mb-3 space-y-0.5">
            <div className="text-sm font-medium">Vim mode</div>
            <p className="text-xs text-muted-foreground">
              How vim motions apply to the built-in editor.
            </p>
          </div>
          <RadioCardGroup<VimModeLevel>
            ariaLabel="Vim mode level"
            value={parseVimModeLevel(vimModeLevel.value)}
            onChange={(next) => vimModeLevel.setValue(next)}
            options={VIM_MODE_LEVEL_OPTIONS}
            layout="stack"
          />
        </SettingsSubsection>
        <SettingsSwitchRow
          label="Auto-save"
          description="Save files automatically after a short delay."
          checked={(autoSave.value ?? "false") === "true"}
          onCheckedChange={(checked) => autoSave.setValue(checked ? "true" : "false")}
          divided
        />
        <SettingsSwitchRow
          label="Git blame"
          description="Show who last changed the current line, and when."
          checked={(gitBlame.value ?? "false") === "true"}
          onCheckedChange={(checked) => gitBlame.setValue(checked ? "true" : "false")}
          divided
        />
        <SettingsRow
          divided
          align="start"
          label="Max open tabs"
          description="The oldest tabs close once you go past the cap. Turn on Unlimited to keep them all."
          control={<MaxOpenTabsControl />}
        />
      </SettingsGroup>
      <SettingsGroup
        id={SETTINGS_ANCHORS.lsp}
        title="Language servers"
        description="Power Cmd/Ctrl-click and F12 go-to-definition. Each server starts the first time you open a matching file."
      >
        <SettingsSubsection>
          <LspServerList />
        </SettingsSubsection>
      </SettingsGroup>
      <SettingsGroup
        id={SETTINGS_ANCHORS.fileTree}
        title="File tree icons"
        description="How much the file tree's icons say about each file, in every project."
      >
        <SettingsSubsection>
          <FileTreeIconSetSelector />
        </SettingsSubsection>
      </SettingsGroup>
    </SettingsPageSection>
  );
}

function MaxOpenTabsControl(): React.JSX.Element {
  const maxTabs = useDebouncedSetting("editor_max_tabs");
  const maxTabsValue = maxTabs.value ?? "10";
  const isLimited = maxTabsValue !== "0";
  const maxTabsNum = isLimited ? parseInt(maxTabsValue, 10) || 10 : 10;
  const setMaxTabsNum = (value: number): void => {
    const clamped = Math.max(1, Math.min(50, value));
    maxTabs.setValue(String(clamped));
  };
  const stepClass =
    "grid size-7 place-items-center rounded-md border border-border bg-card text-sm transition-colors hover:bg-accent disabled:opacity-40";
  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={() => setMaxTabsNum(maxTabsNum - 1)}
        disabled={!isLimited}
        className={stepClass}
        aria-label="Decrease max tabs"
      >
        −
      </button>
      <Input
        type="number"
        min={1}
        max={50}
        disabled={!isLimited}
        value={maxTabsNum}
        aria-label="Max open tabs"
        onChange={(event) => setMaxTabsNum(parseInt(event.target.value, 10) || 1)}
        className="h-7 w-14 text-center disabled:opacity-50"
      />
      <button
        type="button"
        onClick={() => setMaxTabsNum(maxTabsNum + 1)}
        disabled={!isLimited}
        className={stepClass}
        aria-label="Increase max tabs"
      >
        +
      </button>
      <label
        htmlFor="max-tabs-unlimited"
        className="ml-2 flex cursor-pointer items-center gap-2 text-xs text-muted-foreground hover:text-foreground"
      >
        Unlimited
        <Switch
          id="max-tabs-unlimited"
          size="sm"
          checked={!isLimited}
          onCheckedChange={(checked) => maxTabs.setValue(checked ? "0" : "10")}
        />
      </label>
    </div>
  );
}
