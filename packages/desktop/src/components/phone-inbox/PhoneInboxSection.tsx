import type { ReactElement, ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { EYEBROW_TEXT_CLASS } from "@/components/SidebarBlock";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { useUiTranslation } from "@/lib/i18n/ui";

interface InboxSectionProps {
  label: string;
  icon: LucideIcon;
  /** The header's counter; omitted for a section whose size is fixed (Recent). */
  count?: number;
  /** Turns the counter amber: something there needs an action. */
  strong?: boolean;
  loading: boolean;
  error: string | null;
  empty: string;
  isEmpty: boolean;
  children: ReactNode;
  /** Under the cards: For me's "Show N more". */
  footer?: ReactNode;
}

/**
 * One of the inbox's sections (For me, In progress, Recent): the sidebar's
 * eyebrow with its counter, then its cards, a skeleton while they may still
 * arrive, its error, or one muted line when it has none.
 */
export function InboxSection({
  label,
  icon: Icon,
  count,
  strong = false,
  loading,
  error,
  empty,
  isEmpty,
  children,
  footer,
}: InboxSectionProps): ReactElement {
  return (
    <section aria-label={label} className="flex flex-col gap-2">
      <h2 className={cn("flex items-center gap-1.5 px-1", EYEBROW_TEXT_CLASS)}>
        <Icon aria-hidden className="size-3 shrink-0" />
        <span>{label}</span>
        {count !== undefined && count > 0 && (
          <span
            className={cn(
              "rounded-full px-1.5 text-[10px] leading-4 font-semibold tabular-nums",
              strong ? "bg-(--acc-yellow)/20 text-(--acc-yellow)" : "bg-foreground/8",
            )}
          >
            {count}
          </span>
        )}
      </h2>
      <SectionBody loading={loading} error={error} empty={empty} isEmpty={isEmpty} label={label}>
        {children}
      </SectionBody>
      {footer}
    </section>
  );
}

function SectionBody({
  loading,
  error,
  empty,
  isEmpty,
  label,
  children,
}: Pick<
  InboxSectionProps,
  "loading" | "error" | "empty" | "isEmpty" | "label" | "children"
>): ReactElement {
  const { t } = useUiTranslation();
  if (error) {
    return (
      <p role="alert" className="px-1 text-sm text-destructive">
        {error}
      </p>
    );
  }
  if (isEmpty && loading) {
    return (
      <div
        aria-label={t("sidebar.conversationBlock.loading", "Loading {{label}}", { label })}
        aria-busy
        className="flex flex-col gap-2"
      >
        <Skeleton className="h-16 rounded-xl" />
        <Skeleton className="h-16 rounded-xl" />
      </div>
    );
  }
  if (isEmpty) return <p className="px-1 text-sm text-muted-foreground">{empty}</p>;
  return <ul className="flex flex-col gap-2">{children}</ul>;
}
