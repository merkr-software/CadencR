import { translateUi, uiI18n, type UiTranslator } from "@/lib/i18n/ui";
import type { PluginTabSummary, TabAccessLevel, TabBackend } from "@/api/generated";

/**
 * The three custom tab levels (docs/CUSTOM_TABS.md §6), in the user's words.
 * One source for every place that names them — the settings card, the
 * consent dialog, the tab trigger, the "+" menu and the Activity dialog — so
 * a level is never described two ways.
 */
export interface AccessLevelCopy {
  /** Badge text. */
  label: string;
  /** One sentence: what the level lets the tab do. */
  summary: string;
  /** What it can do with the user's rights, added where an update is reviewed; `null` when nothing. */
  reach: string | null;
}

const accessLevelCopyByLevel: Record<TabAccessLevel, (t: UiTranslator) => AccessLevelCopy> = {
  ui: (t) => ({
    label: t("customTabs.access.readOnly", "Read-only"),
    summary: t(
      "customTabs.access.readOnlySummary",
      "Shows a page that reads Cadencr data only through its permissions.",
    ),
    reach: null,
  }),
  commands: (t) => ({
    label: t("customTabs.access.runsCommands", "Runs commands"),
    summary: t(
      "customTabs.access.commandsSummary",
      "Asks Cadencr to run the programs it lists, with arguments it picks, in this conversation's folder.",
    ),
    reach: t(
      "customTabs.access.commandsReach",
      "The programs it runs can run any code on your computer with your user rights.",
    ),
  }),
  backend: (t) => ({
    label: t("customTabs.access.nativeCode", "Native code"),
    summary: t(
      "customTabs.access.nativeSummary",
      "Runs its own program on your computer with your user rights. Cadencr does not sandbox it.",
    ),
    reach: t(
      "customTabs.access.nativeReach",
      "Its program runs on your computer with your user rights.",
    ),
  }),
};

export function accessLevelCopy(level: TabAccessLevel, t: UiTranslator): AccessLevelCopy {
  return accessLevelCopyByLevel[level](t);
}

// Literal class strings: Tailwind only emits arbitrary values it finds verbatim.
// Read-only informs (muted); commands need attention (amber, the needs-action
// level); native code is the riskiest (red).
export const ACCESS_LEVEL_TONE: Record<TabAccessLevel, string> = {
  ui: "bg-muted text-muted-foreground",
  commands: "bg-[color-mix(in_oklab,var(--acc-yellow)_16%,transparent)] text-[var(--acc-yellow)]",
  backend: "bg-[color-mix(in_oklab,var(--acc-red)_14%,transparent)] text-[var(--acc-red)]",
};

/**
 * `bin/darwin-aarch64/impact (darwin-aarch64), bin/linux-x86_64/impact (linux-x86_64)`:
 * the native executable the backend ships for each platform.
 */
export function backendBinaries(backend: TabBackend): string {
  return Object.entries(backend.binary)
    .map(([platform, path]) => `${path} (${platform})`)
    .join(", ");
}

/** The platforms a backend can ship for (docs/TAB_BACKEND_PROTOCOL.md), in the user's words. */
const platformLabel: Partial<Record<string, (t: UiTranslator) => string>> = {
  "darwin-aarch64": (t) => t("customTabs.access.platform.appleSilicon", "macOS (Apple silicon)"),
  "darwin-x86_64": (t) => t("customTabs.access.platform.macIntel", "macOS (Intel)"),
  "linux-x86_64": (t) => t("customTabs.access.platform.linuxX64", "Linux (x86-64)"),
};

const platformListFormats = new Map<string, Intl.ListFormat>();

/** `macOS (Intel) and Linux (x86-64)`: platform keys in the user's words. */
export function platformList(platforms: readonly string[], t: UiTranslator): string {
  const labels = platforms.map((key) =>
    Object.hasOwn(platformLabel, key) ? (platformLabel[key]?.(t) ?? key) : key,
  );
  if (labels.length <= 1) return labels[0] ?? t("customTabs.access.platform.none", "no platform");
  const language = uiI18n.language.startsWith("en") ? "en-GB" : uiI18n.language;
  let formatter = platformListFormats.get(language);
  if (!formatter) {
    formatter = new Intl.ListFormat(language);
    platformListFormats.set(language, formatter);
  }
  return formatter.format(labels);
}

/** Where the backend can run. */
export function backendPlatforms(backend: TabBackend, t: UiTranslator = translateUi): string {
  return platformList(Object.keys(backend.binary), t);
}

/**
 * The tab's backend ships no executable for this computer's platform, so the
 * tab can never run here: no guest, no presence lease, no backend start.
 */
export function backendUnavailableHere<
  T extends Pick<PluginTabSummary, "backend_availability" | "backend">,
>(tab: T): tab is T & { backend: TabBackend } {
  return !!tab.backend && tab.backend_availability === "unavailable_on_platform";
}

/** The label shared by surfaces that show a tab cannot run on this platform. */
export function unavailableHere(t: UiTranslator): string {
  return t("customTabs.access.unavailableHere", "Unavailable on this platform");
}

/** Why a tab can't run on this computer: the platforms (`backendPlatforms`) it does ship for. */
export function unavailableReason(platforms: string, t: UiTranslator = translateUi): string {
  return t(
    "customTabs.access.unavailableReason",
    "Its native backend ships for {{platforms}} only, so the tab can't run on this computer.",
    { platforms },
  );
}

/** A tab version on Cadencr's signed revocation list, said one way on every surface. */
export function blockedCopy(t: UiTranslator) {
  return {
    title: t("customTabs.access.blockedTitle", "Blocked by Cadencr"),
    effect: t(
      "customTabs.access.blockedEffect",
      "This version is on Cadencr's revocation list, so it can't be turned on, opened or run its backend.",
    ),
    remedy: t(
      "customTabs.access.blockedRemedy",
      "Remove it from the Marketplace, or update it to a version that isn't blocked.",
    ),
  };
}

/** A blocklist reason as a sentence of its own, whatever punctuation it came with. */
export function reasonSentence(reason: string): string {
  const text = reason.trim();
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

/** A service reason as the end of a sentence the caller closes: no doubled final stop. */
export function reasonClause(reason: string): string {
  return reason.trim().replace(/[.!?…]+$/, "");
}
