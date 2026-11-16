import type { ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import type { SettingWarning } from "@/api/generated";
import { cn } from "@/lib/utils";

/**
 * The advisory-banner surface: orange `--acc-orange` tone per DESIGN.md
 * (warning, not danger). Shared so every settings warning reads as the same
 * kind of message instead of drifting a few percent apart.
 */
export const WARNING_BANNER_CLASS =
  "rounded-lg border border-[color-mix(in_oklab,var(--acc-orange)_35%,transparent)] bg-[color-mix(in_oklab,var(--acc-orange)_8%,var(--card))] px-3 py-2.5";

/**
 * The blocking counterpart, in `--acc-red`.
 *
 * Spelled out rather than interpolated from a token name: Tailwind only emits
 * an arbitrary-value utility it can find as a literal string in the source, so
 * a class assembled at runtime would silently render with no surface at all.
 */
export const BLOCKING_BANNER_CLASS =
  "rounded-lg border border-[color-mix(in_oklab,var(--acc-red)_35%,transparent)] bg-[color-mix(in_oklab,var(--acc-red)_8%,var(--card))] px-3 py-2.5";

type BannerTone = "warning" | "blocking";

/**
 * The banner frame — tone surface, icon and heading — around any body. Most
 * callers want `SettingsWarningsBanner`; this is for bodies that are not a
 * plain message list (e.g. coded validation issues).
 */
export function SettingsBanner({
  tone = "warning",
  title,
  role,
  children,
}: {
  tone?: BannerTone;
  title: string;
  role?: "alert" | "status";
  children: ReactNode;
}): React.JSX.Element {
  const blocking = tone === "blocking";
  return (
    <div
      role={role}
      className={cn(blocking ? BLOCKING_BANNER_CLASS : WARNING_BANNER_CLASS, "text-xs")}
    >
      <div
        className={cn(
          "flex items-center gap-1.5 font-medium",
          blocking ? "text-[var(--acc-red)]" : "text-[var(--acc-orange)]",
        )}
      >
        <AlertTriangle className="size-3.5" aria-hidden />
        {title}
      </div>
      {children}
    </div>
  );
}

/**
 * Banner listing what a JSON document the backend loaded takes issue with.
 *
 * Two tones, and the distinction is meaningful: `warning` (orange) is advisory
 * — the document still took effect; `blocking` (red) means it did *not*, and
 * the user needs to know that rather than wonder why their edit did nothing.
 */
export function SettingsWarningsBanner({
  warnings,
  tone = "warning",
  title,
}: {
  warnings: SettingWarning[];
  tone?: BannerTone;
  /** Overrides the default "N settings warnings" heading. */
  title?: string;
}): React.JSX.Element | null {
  if (warnings.length === 0) return null;
  const heading =
    title ??
    (warnings.length === 1 ? "1 settings warning" : `${warnings.length} settings warnings`);
  return (
    <SettingsBanner tone={tone} title={heading}>
      <ul className="mt-1.5 space-y-1 text-muted-foreground">
        {warnings.map((w, i) => (
          <li key={`${w.key}-${i}`}>{w.message}</li>
        ))}
      </ul>
    </SettingsBanner>
  );
}
