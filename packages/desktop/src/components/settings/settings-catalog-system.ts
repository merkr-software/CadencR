import { BarChart3, HardDrive, Info } from "lucide-react";
import { SETTINGS_ANCHORS as A } from "./settings-anchor-ids";
import {
  settingsIcon,
  settingsKeywords,
  settingsLabel,
  type SettingsNavGroup,
  type SettingsPageMeta,
  type SettingsTranslator,
} from "./settings-catalog-types";

export function systemSettings(t: SettingsTranslator): SettingsNavGroup {
  return {
    ...settingsLabel(t, "settings.nav.groups.system", "System"),
    pages: [statsPage(t), storagePage(t), aboutPage(t)],
  };
}

function statsPage(t: SettingsTranslator): SettingsPageMeta {
  return {
    id: "stats",
    label: "Usage",
    icon: settingsIcon(BarChart3),
    description:
      "Provider-reported tokens and the messages you send, kept apart from your conversations: archiving or deleting one doesn't erase them.",
    entries: [
      {
        ...settingsLabel(t, "settings.nav.stats.entries.usage-stats.label", "Usage stats"),
        keywords: settingsKeywords(
          t,
          "settings.nav.stats.entries.usage-stats.keywords",
          "tokens, messages, chart",
        ),
      },
    ],
  };
}

function storagePage(t: SettingsTranslator): SettingsPageMeta {
  return {
    id: "storage",
    label: "Storage",
    icon: settingsIcon(HardDrive),
    description:
      "Cadencr always de-duplicates terminal output and moves pasted images to disk; neither loses anything. Compaction is the one pass that shortens content, and it is off until you turn it on.",
    entries: [
      {
        ...settingsLabel(
          t,
          "settings.nav.storage.entries.compact-archived-features.label",
          "Compact archived features",
        ),
        keywords: settingsKeywords(
          t,
          "settings.nav.storage.entries.compact-archived-features.keywords",
          "retention, cleanup, disk",
        ),
      },
    ],
  };
}

function aboutPage(t: SettingsTranslator): SettingsPageMeta {
  return {
    id: "about",
    label: "About",
    icon: settingsIcon(Info),
    description: "Version, updates and diagnostics.",
    entries: [
      {
        ...settingsLabel(
          t,
          "settings.nav.about.entries.check-for-updates.label",
          "Check for updates",
        ),
        keywords: settingsKeywords(
          t,
          "settings.nav.about.entries.check-for-updates.keywords",
          "version, upgrade",
        ),
      },
      {
        ...settingsLabel(
          t,
          "settings.nav.about.entries.export-diagnostics.label",
          "Export diagnostics",
        ),
        anchor: A.diagnostics,
        keywords: settingsKeywords(
          t,
          "settings.nav.about.entries.export-diagnostics.keywords",
          "logs, bug report",
        ),
      },
      {
        ...settingsLabel(
          t,
          "settings.nav.about.entries.privacy-and-telemetry.label",
          "Privacy and telemetry",
        ),
        anchor: A.telemetry,
        keywords: settingsKeywords(
          t,
          "settings.nav.about.entries.privacy-and-telemetry.keywords",
          "sentry, posthog, analytics, consent, anonymous, identity, usage",
        ),
      },
    ],
  };
}
