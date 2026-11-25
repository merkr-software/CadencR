import type { UiTranslator } from "@/lib/i18n/ui";
import {
  BugIcon,
  CloudUploadIcon,
  DatabaseIcon,
  FlaskConicalIcon,
  GitBranchIcon,
  GlobeIcon,
  HammerIcon,
  ListChecksIcon,
  PackageIcon,
  PlayIcon,
  RefreshCwIcon,
  RocketIcon,
  SearchIcon,
  ServerIcon,
  ShieldCheckIcon,
  SparklesIcon,
  TerminalIcon,
  Trash2Icon,
  WrenchIcon,
  ZapIcon,
  type LucideIcon,
} from "lucide-react";

/**
 * Glyphs offered in the action editor. Stored in `icon_data` as
 * `lucide:<name>` beside the legacy uploaded data URIs, so the column needs no
 * migration and an action without either falls back to a monogram.
 */
export const ACTION_ICONS: Readonly<
  Record<string, { glyph: LucideIcon; label: (t: UiTranslator) => string }>
> = {
  play: { glyph: PlayIcon, label: (t) => t("customActions.icon.glyph.play", "play") },
  terminal: {
    glyph: TerminalIcon,
    label: (t) => t("customActions.icon.glyph.terminal", "terminal"),
  },
  test: { glyph: FlaskConicalIcon, label: (t) => t("customActions.icon.glyph.test", "test") },
  checks: { glyph: ListChecksIcon, label: (t) => t("customActions.icon.glyph.checks", "checks") },
  lint: { glyph: SparklesIcon, label: (t) => t("customActions.icon.glyph.lint", "lint") },
  build: { glyph: HammerIcon, label: (t) => t("customActions.icon.glyph.build", "build") },
  package: { glyph: PackageIcon, label: (t) => t("customActions.icon.glyph.package", "package") },
  deploy: { glyph: RocketIcon, label: (t) => t("customActions.icon.glyph.deploy", "deploy") },
  upload: { glyph: CloudUploadIcon, label: (t) => t("customActions.icon.glyph.upload", "upload") },
  server: { glyph: ServerIcon, label: (t) => t("customActions.icon.glyph.server", "server") },
  web: { glyph: GlobeIcon, label: (t) => t("customActions.icon.glyph.web", "web") },
  database: {
    glyph: DatabaseIcon,
    label: (t) => t("customActions.icon.glyph.database", "database"),
  },
  git: { glyph: GitBranchIcon, label: (t) => t("customActions.icon.glyph.git", "git") },
  refresh: { glyph: RefreshCwIcon, label: (t) => t("customActions.icon.glyph.refresh", "refresh") },
  debug: { glyph: BugIcon, label: (t) => t("customActions.icon.glyph.debug", "debug") },
  fix: { glyph: WrenchIcon, label: (t) => t("customActions.icon.glyph.fix", "fix") },
  security: {
    glyph: ShieldCheckIcon,
    label: (t) => t("customActions.icon.glyph.security", "security"),
  },
  search: { glyph: SearchIcon, label: (t) => t("customActions.icon.glyph.search", "search") },
  fast: { glyph: ZapIcon, label: (t) => t("customActions.icon.glyph.fast", "fast") },
  clean: { glyph: Trash2Icon, label: (t) => t("customActions.icon.glyph.clean", "clean") },
};

const LUCIDE_PREFIX = "lucide:";

export function lucideIconValue(name: string): string {
  return `${LUCIDE_PREFIX}${name}`;
}

/** The glyph an `icon_data` value names, if it names one we ship. */
export function lucideIconFor(iconData: string | null | undefined): LucideIcon | null {
  if (!iconData?.startsWith(LUCIDE_PREFIX)) return null;
  return ACTION_ICONS[iconData.slice(LUCIDE_PREFIX.length)]?.glyph ?? null;
}

export function isImageIcon(iconData: string | null | undefined): iconData is string {
  return iconData?.startsWith("data:image/") === true;
}

/** One or two letters standing for the action: "Run tests" → "RT". */
export function actionMonogram(name: string): string {
  const words = name
    .trim()
    .split(/[\s_\-:/.]+/)
    .filter(Boolean);
  if (words.length === 0) return "?";
  const letters = words.length === 1 ? words[0].slice(0, 2) : `${words[0][0]}${words[1][0]}`;
  return letters.toUpperCase();
}
