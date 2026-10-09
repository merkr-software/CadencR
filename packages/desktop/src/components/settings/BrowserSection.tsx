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
import { SettingsCard } from "./SettingsCard";
import { SettingsSection } from "./SettingsSection";
import { SettingsSubsection } from "./SettingsSubsection";
import { RadioCardGroup, type RadioCardOption } from "./RadioCardGroup";
import { InternalDomainsEditor } from "./InternalDomainsEditor";

/**
 * Browser workspace preferences:
 *  1. Default cookie mode (Normal / Private) used for the first tab and as the
 *     toolbar toggle's initial value.
 */
export function BrowserSection(): React.JSX.Element {
  const modeSetting = useDebouncedSetting(BROWSER_DEFAULT_MODE_SETTING_KEY, 0);
  const searchSetting = useDebouncedSetting(BROWSER_SEARCH_ENGINE_SETTING_KEY, 0, {
    immediateCache: false,
  });
  const mode = parseCookieMode(modeSetting.value);
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
    <SettingsSection id="browser" title="Browser" subtitle="Cookie mode and link routing">
      <SettingsCard>
        <SettingsSubsection
          title="Default mode"
          description="Which cookie mode new Browser tabs open in. Private sessions are in-memory only and cleared when the tab closes."
        >
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
        <SettingsSubsection
          title="Search engine"
          description="Used only when you submit search terms in the Browser address bar. Suggestions stay on this device."
        >
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
        <SettingsSubsection
          title="Open in Cadencr's browser"
          description="Links to these domains (and their subdomains) open in a Cadencr browser tab when clicked in agent chat or Cmd/Ctrl+clicked in the terminal. Everything else opens in your system browser."
        >
          <InternalDomainsEditor />
        </SettingsSubsection>
      </SettingsCard>
    </SettingsSection>
  );
}
