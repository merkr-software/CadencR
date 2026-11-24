import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { SettingsHeading } from "./SettingsHeading";

/**
 * Rounded card surface used to group settings inside a section. One card per
 * main section: a recessed, slightly-darker-than-page surface whose fill (not
 * a hard outline) carries the grouping. Sub-sections live inside as
 * `SettingsSubsection`s, separated by hairline dividers.
 *
 * `padded` / `title` / `description` / `action` remain for the simple
 * single-block case (and the project-settings modal). When a card hosts
 * multiple `SettingsSubsection`s, omit the card-level `title` and let each
 * sub-section render its own header + divider.
 */
export function SettingsCard({
  children,
  padded = false,
  className,
  tone = "default",
  title,
  description,
  action,
}: {
  children: ReactNode;
  padded?: boolean;
  className?: string;
  /** `danger` adds the soft-red border + tinted background for dangerous toggles. */
  tone?: "default" | "danger";
  /** Sub-heading naming the group. Renders the consistent card header. */
  title?: ReactNode;
  /** Muted one-liner below the title. Only shown when `title` is set. */
  description?: ReactNode;
  /** Trailing control aligned with the title (e.g. a "New profile" button). */
  action?: ReactNode;
}): React.JSX.Element {
  return (
    <div
      className={cn(
        // Each section reads as its own recessed panel via `--surface-sunken`,
        // a per-theme token (darker than the page in dark themes, a subtle gray
        // well below it in light themes) — not a hardcoded darken, which would
        // muddy the near-white light themes.
        "overflow-hidden rounded-xl border",
        tone === "danger"
          ? "border-[color-mix(in_oklab,var(--acc-red)_35%,transparent)] bg-[color-mix(in_oklab,var(--acc-red)_5%,var(--card))]"
          : "border-border/60 bg-[var(--surface-sunken)]",
        padded && "p-5 phone:p-4",
        className,
      )}
    >
      {title ? (
        <div className={padded ? "mb-4" : "px-5 pt-4"}>
          <SettingsHeading title={title} description={description} action={action} />
        </div>
      ) : null}
      {children}
    </div>
  );
}
