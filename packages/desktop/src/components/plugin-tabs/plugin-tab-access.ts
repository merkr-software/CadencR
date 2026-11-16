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

export const ACCESS_LEVEL_COPY: Record<TabAccessLevel, AccessLevelCopy> = {
  ui: {
    label: "Read-only",
    summary: "Shows a page that reads Cadencr data only through its permissions.",
    reach: null,
  },
  commands: {
    label: "Runs commands",
    summary:
      "Asks Cadencr to run the programs it lists, with arguments it picks, in this conversation's folder.",
    reach: "The programs it runs can run any code on your computer with your user rights.",
  },
  backend: {
    label: "Native code",
    summary:
      "Runs its own program on your computer with your user rights. Cadencr does not sandbox it.",
    reach: "Its program runs on your computer with your user rights.",
  },
};

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
const PLATFORM_LABEL: Record<string, string> = {
  "darwin-aarch64": "macOS (Apple silicon)",
  "darwin-x86_64": "macOS (Intel)",
  "linux-x86_64": "Linux (x86-64)",
};

/** `macOS (Intel) and Linux (x86-64)`: platform keys in the user's words. */
export function platformList(platforms: readonly string[]): string {
  const labels = platforms.map((key) => PLATFORM_LABEL[key] ?? key);
  if (labels.length <= 1) return labels[0] ?? "no platform";
  return `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`;
}

/** Where the backend can run. */
export function backendPlatforms(backend: TabBackend): string {
  return platformList(Object.keys(backend.binary));
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

/** "Unavailable on this platform", said one way wherever a tab can't run here. */
export const UNAVAILABLE_HERE = "Unavailable on this platform";

/** Why a tab can't run on this computer: the platforms (`backendPlatforms`) it does ship for. */
export function unavailableReason(platforms: string): string {
  return `Its native backend ships for ${platforms} only, so the tab can't run on this computer.`;
}

/** A tab version on Cadencr's signed revocation list, said one way on every surface. */
export const BLOCKED_COPY = {
  title: "Blocked by Cadencr",
  effect:
    "This version is on Cadencr's revocation list, so it can't be turned on, opened or run its backend.",
  remedy: "Remove it from the Marketplace, or update it to a version that isn't blocked.",
} as const;

/** A blocklist reason as a sentence of its own, whatever punctuation it came with. */
export function reasonSentence(reason: string): string {
  const text = reason.trim();
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

/** A service reason as the end of a sentence the caller closes: no doubled final stop. */
export function reasonClause(reason: string): string {
  return reason.trim().replace(/[.!?…]+$/, "");
}
