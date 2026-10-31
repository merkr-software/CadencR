import type { ReactNode } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/**
 * A titled block of settings.
 *
 * `lg` is a whole page of the settings screen: a 20px title, the page's
 * one-sentence purpose, then its `SettingsGroup`s, generously spaced. `sm` is
 * a section of the project-settings modal, where vertical density matters
 * more: title and right-aligned `subtitle` on one line, content close below.
 *
 * The `id` is set as both an HTML id and a `data-section` attribute so deep
 * links can resolve it.
 */
export function SettingsSection({
  id,
  title,
  subtitle,
  description,
  size = "lg",
  className,
  children,
}: {
  id?: string;
  title: ReactNode;
  /** `sm` only: right-aligned summary next to the title (e.g. "Color · Icon"). */
  subtitle?: ReactNode;
  /** The page's purpose (`lg`) or a long-form intro paragraph (`sm`). */
  description?: ReactNode;
  size?: "lg" | "sm";
  className?: string;
  children?: ReactNode;
}): React.JSX.Element {
  // One provider per section: hints inside open without the delay once one shows.
  const content = <TooltipProvider delayDuration={300}>{children}</TooltipProvider>;

  if (size === "lg") {
    return (
      <section
        id={id}
        data-section={id ?? ""}
        aria-labelledby={id ? `${id}-title` : undefined}
        className={cn("scroll-mt-6", className)}
      >
        <header className="mb-8 space-y-1.5">
          <h2 id={id ? `${id}-title` : undefined} className="text-xl font-semibold tracking-tight">
            {title}
          </h2>
          {description ? (
            <p className="max-w-[68ch] text-[13px] leading-relaxed text-pretty text-muted-foreground">
              {description}
            </p>
          ) : null}
        </header>
        <div className="space-y-9">{content}</div>
      </section>
    );
  }

  return (
    <section id={id} data-section={id ?? ""} className={cn("space-y-3 scroll-mt-6", className)}>
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="text-sm font-semibold">{title}</h2>
        {subtitle ? (
          <span className="text-xs text-muted-foreground truncate">{subtitle}</span>
        ) : null}
      </div>
      {description ? (
        <p className="-mt-1 text-xs text-muted-foreground leading-snug">{description}</p>
      ) : null}
      {content}
    </section>
  );
}
