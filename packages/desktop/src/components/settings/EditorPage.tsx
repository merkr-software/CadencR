import { LoaderCircle } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useSetting } from "@/hooks/useSetting";
import { useSettingDraft } from "@/hooks/useSettingDraft";
import { FileTreeIconSetSelector } from "./FileTreeIconSetSelector";
import { LanguageServerSettings } from "./LanguageServerSettings";
import { EditorBackendSetting } from "./EditorBackendSetting";
import { NeovimPluginMigration } from "./NeovimPluginMigration";
import { VimMotionsSetting } from "./VimMotionsSetting";
import { SettingsGroup } from "./SettingsGroup";
import { SettingsRow } from "./SettingsRow";
import { SettingsPageSection } from "./SettingsPageSection";
import { SettingsSubsection } from "./SettingsSubsection";
import { SettingsSwitchRow } from "./SettingsSwitchRow";
import { SETTINGS_ANCHORS } from "./settings-anchor-ids";

/** Settings → Editor: the built-in code editor, its language servers and file tree. */
export function EditorPage(): React.JSX.Element {
  const autoSave = useSetting("editor_auto_save");
  const gitBlame = useSetting("editor_git_blame");

  return (
    <SettingsPageSection pageId="editor">
      <SettingsGroup id={SETTINGS_ANCHORS.editing} title="Editing">
        <SettingsSubsection>
          <EditorBackendSetting />
          <NeovimPluginMigration />
        </SettingsSubsection>
        <VimMotionsSetting />
        <SettingsSwitchRow
          label="Auto-save"
          description="Save files automatically after a short delay."
          checked={(autoSave.value ?? "false") === "true"}
          onCheckedChange={(checked) => void autoSave.setValue(checked ? "true" : "false")}
          saving={autoSave.isSaving}
          divided
        />
        <SettingsSwitchRow
          label="Git blame"
          description="Show who last changed the current line, and when."
          checked={(gitBlame.value ?? "false") === "true"}
          onCheckedChange={(checked) => void gitBlame.setValue(checked ? "true" : "false")}
          saving={gitBlame.isSaving}
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
        description="Choose completions, navigation and diagnostics for each language. Installed servers start when you open a matching file."
      >
        <SettingsSubsection>
          <LanguageServerSettings />
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

/** How long typing or stepping must pause before the cap is saved. */
const MAX_TABS_SAVE_DEBOUNCE_MS = 400;

function MaxOpenTabsControl(): React.JSX.Element {
  // Typed and stepped values show at once as a draft, kept apart from the
  // saved cap: the backend's value replaces it once saved, or once saving fails.
  const maxTabs = useSettingDraft("editor_max_tabs", MAX_TABS_SAVE_DEBOUNCE_MS);
  const maxTabsValue = maxTabs.draft ?? maxTabs.value ?? "10";
  const isLimited = maxTabsValue !== "0";
  const maxTabsNum = isLimited ? parseInt(maxTabsValue, 10) || 10 : 10;
  const setMaxTabsNum = (value: number): void => {
    const clamped = Math.max(1, Math.min(50, value));
    maxTabs.setDraft(String(clamped));
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
          onCheckedChange={(checked) => maxTabs.setDraft(checked ? "0" : "10")}
        />
      </label>
      {maxTabs.isSaving && (
        <LoaderCircle aria-label="Saving max open tabs" className="size-3.5 animate-spin" />
      )}
    </div>
  );
}
