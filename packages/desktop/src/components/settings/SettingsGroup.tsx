import { useId, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { SettingsCard } from "./SettingsCard";

/**
 * One group of related settings on a settings page: its name (and an optional
 * one-line note) above a card holding the rows. The name sits outside the card
 * so a page reads as a short list of named lists, the way macOS and Linear lay
 * out preferences, and every row inside the card looks the same.
 *
 * `id` is the scroll target for search results and `?section=` deep links
 * (see `settings-anchor-ids.ts`). Pass `bare` when the content brings its own
 * surfaces (a list of cards, a chart), so cards are never nested.
 */
export function SettingsGroup({
  id,
  title,
  description,
  action,
  bare = false,
  className,
  children,
}: {
  id?: string;
  title: ReactNode;
  description?: ReactNode;
  /** Trailing control aligned with the title (e.g. "New profile"). */
  action?: ReactNode;
  bare?: boolean;
  className?: string;
  children: ReactNode;
}): React.JSX.Element {
  const headingId = useId();
  return (
    <section
      id={id}
      aria-labelledby={headingId}
      data-settings-group=""
      className={cn("scroll-mt-6 space-y-3", className)}
    >
      <div className="flex items-end justify-between gap-4 px-1">
        <div className="min-w-0 space-y-1">
          <h3 id={headingId} className="text-[13px] font-semibold leading-tight">
            {title}
          </h3>
          {description ? (
            <p className="max-w-[68ch] text-xs leading-snug text-pretty text-muted-foreground">
              {description}
            </p>
          ) : null}
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
      {bare ? children : <SettingsCard>{children}</SettingsCard>}
    </section>
  );
}
