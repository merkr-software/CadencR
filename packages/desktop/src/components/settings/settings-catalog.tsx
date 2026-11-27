import { preferencesSettings } from "./settings-catalog-preferences";
import { agentsSettings } from "./settings-catalog-agents";
import { toolsSettings } from "./settings-catalog-tools";
import { systemSettings } from "./settings-catalog-system";
import {
  settingsLabel,
  type SettingsNavGroup,
  type SettingsPageId,
  type SettingsPageMeta,
  type SettingsTranslator,
} from "./settings-catalog-types";

export type {
  SettingsEntry,
  SettingsNavGroup,
  SettingsPageId,
  SettingsPageMeta,
  SettingsRequirement,
  SettingsTranslator,
} from "./settings-catalog-types";

/**
 * The settings page's map: which pages exist, how the rail groups them, and
 * every setting a search can land on. Kept free of the page components so the
 * command palette can import it without pulling every settings screen in.
 *
 * `?section=` accepts a page id, one of its `aliases` (the ids of sections that
 * were merged into it), or an entry's `anchor`. Each anchor must be rendered as
 * an element id by its page, or a deep link lands at the page's top.
 */

export function settingsNavGroups(t: SettingsTranslator): SettingsNavGroup[] {
  return [preferencesSettings(t), agentsSettings(t), toolsSettings(t), systemSettings(t)].map(
    (group) => ({
      ...group,
      pages: group.pages.map((page) => ({ ...page, ...settingsPageCopy(page, t) })),
    }),
  );
}

export const SETTINGS_NAV_GROUPS: readonly SettingsNavGroup[] = settingsNavGroups(
  (_key, defaultValue) => defaultValue,
);

export const SETTINGS_PAGES: readonly SettingsPageMeta[] = SETTINGS_NAV_GROUPS.flatMap(
  (group) => group.pages,
);

/** A page's catalog entry; every `SettingsPageId` has one. */
export function settingsPageMeta(id: SettingsPageId): SettingsPageMeta {
  const page = SETTINGS_PAGES.find((candidate) => candidate.id === id);
  if (!page) throw new Error(`Settings page "${id}" is missing from the catalog`);
  return page;
}

export function settingsPageCopy(
  page: Pick<SettingsPageMeta, "id" | "label" | "description">,
  t: SettingsTranslator,
) {
  return {
    ...settingsLabel(t, `settings.nav.${page.id}.label`, page.label),
    description: t(`settings.nav.${page.id}.description`, page.description),
  };
}

export const DEFAULT_SETTINGS_PAGE: SettingsPageId = "general";

export interface ResolvedSettingsTarget {
  page: SettingsPageMeta;
  /** Element to scroll to inside the page; none means the page's top. */
  anchor: string | null;
}

/**
 * What a `?section=` value opens. Unknown values resolve to nothing so the
 * caller can fall back to its default page instead of an empty screen.
 */
export function resolveSettingsTarget(section: string | undefined): ResolvedSettingsTarget | null {
  if (!section) return null;
  for (const page of SETTINGS_PAGES) {
    if (page.id === section) return { page, anchor: null };
    if (page.aliases?.includes(section)) return { page, anchor: section };
    if (page.entries.some((entry) => entry.anchor === section)) return { page, anchor: section };
  }
  return null;
}
