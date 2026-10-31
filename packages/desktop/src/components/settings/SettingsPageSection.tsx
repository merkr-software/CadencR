import type { ReactNode } from "react";
import { SettingsSection } from "./SettingsSection";
import { settingsPageMeta, type SettingsPageId } from "./settings-catalog";

/**
 * A settings page's frame: its title and purpose come from the catalog, the
 * same text the rail, the search and the command palette show, so the page
 * and its palette command never disagree. The root id is prefixed so it can't
 * collide with app chrome sharing a page's name (the app sidebar panel is
 * `#sidebar`).
 */
export function SettingsPageSection({
  pageId,
  description,
  children,
}: {
  pageId: SettingsPageId;
  /** Rich markup (a shortcut chord) in place of the catalog's plain sentence. */
  description?: ReactNode;
  children?: ReactNode;
}): React.JSX.Element {
  const page = settingsPageMeta(pageId);
  return (
    <SettingsSection
      id={`settings-page-${pageId}`}
      title={page.label}
      description={description ?? page.description}
    >
      {children}
    </SettingsSection>
  );
}
