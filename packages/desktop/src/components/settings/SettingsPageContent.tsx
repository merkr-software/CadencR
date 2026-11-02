import { memo, type ComponentType } from "react";
import { AboutSection } from "./AboutSection";
import { AgentsPage } from "./AgentsPage";
import { AppearancePage } from "./AppearancePage";
import { BrowserSection } from "./BrowserSection";
import { CustomActionsSettingsSection } from "./CustomActionsSettingsSection";
import { CustomTabsSection } from "./custom-tabs/CustomTabsSection";
import { EditorPage } from "./EditorPage";
import { GeneralPage } from "./GeneralPage";
import { GitSection } from "./GitSection";
import { McpSection } from "./McpSection";
import { NotificationsSection } from "./NotificationsSection";
import { ProvidersSection } from "./ProvidersSection";
import { SidebarSection } from "./SidebarSection";
import { StatsSection } from "./StatsSection";
import { StorageSection } from "./StorageSection";
import type { SettingsPageId } from "./settings-catalog";

/** The screen for each settings page; the catalog holds everything else about it. */
const PAGES: Record<SettingsPageId, ComponentType> = {
  general: GeneralPage,
  appearance: AppearancePage,
  sidebar: SidebarSection,
  notifications: NotificationsSection,
  agents: AgentsPage,
  providers: ProvidersSection,
  mcp: McpSection,
  editor: EditorPage,
  git: GitSection,
  browser: BrowserSection,
  "custom-tabs": CustomTabsSection,
  actions: CustomActionsSettingsSection,
  stats: StatsSection,
  storage: StorageSection,
  about: AboutSection,
};

/**
 * Memoized on `pageId` alone: the route re-renders on every keystroke in the
 * settings search, and the page (live previews, charts) has no use for it.
 */
export const SettingsPageContent = memo(function SettingsPageContent({
  pageId,
}: {
  pageId: SettingsPageId;
}): React.JSX.Element {
  const Page = PAGES[pageId];
  return <Page />;
});
