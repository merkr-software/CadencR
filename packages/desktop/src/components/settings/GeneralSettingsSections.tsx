import { Files, History, Save } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { NotificationsSection } from "@/components/settings/NotificationsSection";
import { BrowserSection } from "@/components/settings/BrowserSection";
import { CustomTabsSection } from "@/components/settings/custom-tabs/CustomTabsSection";
import { CustomActionsSettingsSection } from "@/components/settings/CustomActionsSettingsSection";
import { StorageSection } from "@/components/settings/StorageSection";
import { McpSection } from "@/components/settings/McpSection";
import { InterfaceSection } from "@/components/settings/InterfaceSection";
import { SidebarSection } from "@/components/settings/SidebarSection";
import { SidebarViewsSection } from "@/components/settings/SidebarViewsSection";
import { GitSection } from "@/components/settings/GitSection";
import { ProvidersSection } from "@/components/settings/ProvidersSection";
import { AboutSection } from "@/components/settings/AboutSection";
import { StatsSection } from "@/components/settings/StatsSection";
import { AgentVerbositySettings } from "@/components/settings/AgentVerbositySettings";
import { AgentSummaryModeToggle } from "@/components/settings/AgentSummaryModeToggle";
import { ThemeSelector } from "@/components/settings/ThemeSelector";
import { FontSelector } from "@/components/settings/FontSelector";
import { ThemeLibrary } from "@/components/theme/ThemeLibrary";
import { FileTreeIconSetSelector } from "@/components/settings/FileTreeIconSetSelector";
import { LspServerList } from "@/components/settings/LspServerList";
import { AnimationsToggle } from "@/components/settings/AnimationsToggle";
import { SettingsSection } from "@/components/settings/SettingsSection";
import { SettingsCard } from "@/components/settings/SettingsCard";
import { WorkspaceJsonSettings } from "@/components/settings/SettingsJsonControls";
import { SettingsSubsection } from "@/components/settings/SettingsSubsection";
import { SettingsRow } from "@/components/settings/SettingsRow";
import { SettingsSwitchRow } from "@/components/settings/SettingsSwitchRow";
import { IconTile } from "@/components/settings/IconTile";
import { useDebouncedSetting } from "@/hooks/useDebouncedSetting";
import { AutoNameSettingsSection } from "@/components/settings/AutoNameSettingsSection";
import { RadioCardGroup, type RadioCardOption } from "@/components/settings/RadioCardGroup";
import { parseVimModeLevel, type VimModeLevel } from "@/lib/vim-mode-level";

export function GeneralSettingsSections(): React.JSX.Element {
  return (
    <>
      <SettingsCard padded>
        <WorkspaceJsonSettings />
      </SettingsCard>
      <AppearanceSection />
      <EditorSection />
      <InterfaceSection />
      <SidebarSection />
      <SidebarViewsSection />
      <NotificationsSection />
      <BrowserSection />
      <CustomTabsSection />
      <CustomActionsSettingsSection />
      <StorageSection />
      <McpSection />
      <AutoNameSettingsSection />
      <GitSection />
      <ProvidersSection />
      <StatsSection />
      <AboutSection />
    </>
  );
}

/* ─── Appearance ─────────────────────────────────────────────────────── */

function AppearanceSection(): React.JSX.Element {
  return (
    <SettingsSection id="appearance" title="Appearance" subtitle="Theme · Animations · Verbosity">
      <SettingsCard>
        <SettingsSubsection padded={false}>
          <ThemeSelector />
          <AnimationsToggle divided />
        </SettingsSubsection>
        <FontSelector />
        <SettingsSubsection
          title="Theme library"
          description="Start from any theme you like and make it your own. Each theme gets a project of its own in the sidebar: change the JSON by hand or ask the agent for it, keep working anywhere in the app, and watch it restyle itself as you go. Your themes appear in the picker alongside the built-ins."
        >
          <ThemeLibrary />
        </SettingsSubsection>
        <SettingsSubsection
          title="Agent output verbosity"
          description="Control how much of each agent turn stays expanded in the stream. Switching modes does not affect what the agent does. It only changes how the output is rendered."
        >
          <AgentVerbositySettings />
          <AgentSummaryModeToggle />
        </SettingsSubsection>
      </SettingsCard>
    </SettingsSection>
  );
}

/* ─── Editor ─────────────────────────────────────────────────────────── */

function MaxOpenTabsControl(): React.JSX.Element {
  const maxTabs = useDebouncedSetting("editor_max_tabs");
  const maxTabsValue = maxTabs.value ?? "10";
  const isLimited = maxTabsValue !== "0";
  const maxTabsNum = isLimited ? parseInt(maxTabsValue, 10) || 10 : 10;
  const setMaxTabsNum = (value: number): void => {
    const clamped = Math.max(1, Math.min(50, value));
    maxTabs.setValue(String(clamped));
  };
  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={() => setMaxTabsNum(maxTabsNum - 1)}
        disabled={!isLimited}
        className="grid size-7 place-items-center rounded-md border border-border bg-card text-sm transition-colors hover:bg-accent disabled:opacity-40"
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
        onChange={(event) => setMaxTabsNum(parseInt(event.target.value, 10) || 1)}
        className="h-7 w-14 text-center disabled:opacity-50"
      />
      <button
        type="button"
        onClick={() => setMaxTabsNum(maxTabsNum + 1)}
        disabled={!isLimited}
        className="grid size-7 place-items-center rounded-md border border-border bg-card text-sm transition-colors hover:bg-accent disabled:opacity-40"
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

function useVimModeLevelOptions(): RadioCardOption<VimModeLevel>[] {
  return [
    {
      value: "0",
      label: "Off",
      description: "Standard editing, no vim motions.",
    },
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
}

function EditorSection(): React.JSX.Element {
  const vimModeLevel = useDebouncedSetting("editor_vim_mode_level");
  const autoSave = useDebouncedSetting("editor_auto_save");
  const gitBlame = useDebouncedSetting("editor_git_blame");
  const vimModeLevelOptions = useVimModeLevelOptions();

  const currentVimModeLevel = parseVimModeLevel(vimModeLevel.value);
  const isAutoSaveEnabled = (autoSave.value ?? "false") === "true";
  const isGitBlameEnabled = (gitBlame.value ?? "false") === "true";

  return (
    <SettingsSection id="editor" title="Editor" subtitle="CodeMirror · File tree">
      <SettingsCard>
        <SettingsSubsection
          title="File tree icons"
          description="Controls the icon density of the editor's file tree. Affects every project."
        >
          <FileTreeIconSetSelector />
        </SettingsSubsection>
        <SettingsSubsection
          title="Language servers"
          description="Cmd-click and F12 jump-to-definition use these. Servers launch on demand the first time you open a matching file."
        >
          <LspServerList />
        </SettingsSubsection>
        <SettingsSubsection
          title="Vim mode"
          description="Choose how vim motions apply to the built-in code editor."
        >
          <RadioCardGroup<VimModeLevel>
            ariaLabel="Vim mode level"
            value={currentVimModeLevel}
            onChange={(next) => vimModeLevel.setValue(next)}
            options={vimModeLevelOptions}
            layout="stack"
          />
        </SettingsSubsection>
        <SettingsSubsection padded={false}>
          <SettingsSwitchRow
            icon={<Save className="size-4" />}
            iconTint="green"
            label="Auto-save"
            description="Automatically save files after a short delay."
            checked={isAutoSaveEnabled}
            onCheckedChange={(checked) => autoSave.setValue(checked ? "true" : "false")}
            divided
          />
          <SettingsSwitchRow
            icon={<History className="size-4" />}
            iconTint="orange"
            label="Git blame"
            description="Show blame annotation on the current line."
            checked={isGitBlameEnabled}
            onCheckedChange={(checked) => gitBlame.setValue(checked ? "true" : "false")}
            divided
          />
          <SettingsRow
            divided
            align="start"
            icon={
              <IconTile tint="pink">
                <Files className="size-4" />
              </IconTile>
            }
            label="Max open tabs"
            description="Older tabs are closed once you exceed the cap. Disable to keep them all."
            control={<MaxOpenTabsControl />}
          />
        </SettingsSubsection>
      </SettingsCard>
    </SettingsSection>
  );
}
