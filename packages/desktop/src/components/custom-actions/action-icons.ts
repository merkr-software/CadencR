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
export const ACTION_ICONS: Readonly<Record<string, LucideIcon>> = {
  play: PlayIcon,
  terminal: TerminalIcon,
  test: FlaskConicalIcon,
  checks: ListChecksIcon,
  lint: SparklesIcon,
  build: HammerIcon,
  package: PackageIcon,
  deploy: RocketIcon,
  upload: CloudUploadIcon,
  server: ServerIcon,
  web: GlobeIcon,
  database: DatabaseIcon,
  git: GitBranchIcon,
  refresh: RefreshCwIcon,
  debug: BugIcon,
  fix: WrenchIcon,
  security: ShieldCheckIcon,
  search: SearchIcon,
  fast: ZapIcon,
  clean: Trash2Icon,
};

const LUCIDE_PREFIX = "lucide:";

export function lucideIconValue(name: string): string {
  return `${LUCIDE_PREFIX}${name}`;
}

/** The glyph an `icon_data` value names, if it names one we ship. */
export function lucideIconFor(iconData: string | null | undefined): LucideIcon | null {
  if (!iconData?.startsWith(LUCIDE_PREFIX)) return null;
  return ACTION_ICONS[iconData.slice(LUCIDE_PREFIX.length)] ?? null;
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
