import { createElement, useMemo } from "react";
import { Loader2Icon } from "lucide-react";
import { useDebouncedSetting } from "@/hooks/useDebouncedSetting";
import {
  BROWSER_DEFAULT_MODE_SETTING_KEY,
  BROWSER_MODE_OPTIONS,
  BROWSER_SEARCH_ENGINE_OPTIONS,
  BROWSER_SEARCH_ENGINE_SETTING_KEY,
  parseCookieMode,
  parseBrowserSearchEngine,
  type BrowserSearchEngine,
  type CookieMode,
} from "@/lib/browser-settings";
import { useIsMobile } from "@/hooks/useIsMobile";
import { AutoLayoutDefaultSetting } from "./AutoLayoutDefaultSetting";
import { SettingsGroup } from "./SettingsGroup";
import { SETTINGS_ANCHORS } from "./settings-anchor-ids";
import { SettingsPageSection } from "./SettingsPageSection";
import { SettingsSubsection } from "./SettingsSubsection";
import { RadioCardGroup, type RadioCardOption } from "./RadioCardGroup";
import { InternalDomainsEditor } from "./InternalDomainsEditor";

/**
 * Browser workspace preferences:
 *  1. Auto layout default (desktop): whether the Browser splits beside the agent.
 *  2. Default cookie mode (Normal / Private) used for the first tab and as the
 *     toolbar toggle's initial value.
 *  3. Search engine, and the domains whose links open in Cadencr's browser.
 */
export function BrowserSection(): React.JSX.Element {
  const modeSetting = useDebouncedSetting(BROWSER_DEFAULT_MODE_SETTING_KEY, 0);
  const searchSetting = useDebouncedSetting(BROWSER_SEARCH_ENGINE_SETTING_KEY, 0, {
    immediateCache: false,
  });
  const mode = parseCookieMode(modeSetting.value);
  const isMobile = useIsMobile();
  const searchEngine = parseBrowserSearchEngine(searchSetting.value);

  const options = useMemo<RadioCardOption<CookieMode>[]>(
    () =>
      BROWSER_MODE_OPTIONS.map((option) => ({
        value: option.value,
        label: option.label,
        description: option.description,
        visual: createElement(option.icon, {
          className: "mt-0.5 size-4",
          style: { color: option.iconColorVar },
        }),
      })),
    [],
  );
  const searchOptions = useMemo<RadioCardOption<BrowserSearchEngine>[]>(
    () =>
      BROWSER_SEARCH_ENGINE_OPTIONS.map((option) => ({ value: option.value, label: option.label })),
    [],
  );

  return (
    <SettingsPageSection pageId="browser">
      {/* Auto layout splits the feature page, which only the desktop shell lays out. */}
      {!isMobile ? (
        <SettingsGroup id={SETTINGS_ANCHORS.browserLayout} title="Layout">
          <AutoLayoutDefaultSetting />
        </SettingsGroup>
      ) : null}
      <SettingsGroup
        id={SETTINGS_ANCHORS.browserMode}
        title="Default mode"
        description="The cookie mode new Browser tabs open in. Private sessions live in memory only and are cleared when the tab closes."
      >
        <SettingsSubsection>
          <RadioCardGroup<CookieMode>
            ariaLabel="Default browser mode"
            value={mode}
            onChange={modeSetting.setValue}
            options={options}
            layout="grid"
            showDot={false}
            disabled={modeSetting.isLoading}
          />
        </SettingsSubsection>
      </SettingsGroup>
      <SettingsGroup
        id={SETTINGS_ANCHORS.browserSearch}
        title="Search engine"
        description="Used only when you submit search terms in the address bar. Suggestions stay on this device."
      >
        <SettingsSubsection>
          <RadioCardGroup<BrowserSearchEngine>
            ariaLabel="Browser search engine"
            value={searchEngine}
            onChange={searchSetting.setValue}
            options={searchOptions}
            layout="grid"
            disabled={searchSetting.isLoading || searchSetting.isSaving}
          />
          {searchSetting.isSaving ? (
            <div
              role="status"
              className="mt-2 flex items-center gap-2 text-xs text-muted-foreground"
            >
              <Loader2Icon className="size-3.5 animate-spin" /> Saving search engine…
            </div>
          ) : null}
        </SettingsSubsection>
      </SettingsGroup>
      <SettingsGroup
        id={SETTINGS_ANCHORS.browserDomains}
        title="Open in Cadencr's browser"
        description="Links to these domains and their subdomains open in a Cadencr Browser tab when clicked in agent chat or Cmd/Ctrl+clicked in the terminal. Everything else opens in your system browser."
      >
        <SettingsSubsection>
          <InternalDomainsEditor />
        </SettingsSubsection>
      </SettingsGroup>
    </SettingsPageSection>
  );
}
