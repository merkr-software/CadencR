import { useUiTranslation } from "@/lib/i18n/ui";
import type { ReactElement } from "react";
import { Button } from "@/components/ui/button";
import type { ShowMore } from "@/hooks/useForMeShowMore";

/**
 * The quiet line under a limited block's rows: "Show 2 more", then "Show
 * less". A sidebar nav item, so ↑/↓ reach it and Enter toggles it.
 */
export function SidebarShowMoreButton({ more }: { more: ShowMore }): ReactElement | null {
  const { t } = useUiTranslation();
  if (more.hiddenCount === 0) return null;
  return (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      data-nav-item
      data-sidebar-show-more
      aria-expanded={more.expanded}
      onClick={more.toggle}
      className="self-start px-2 text-[11px] phone:h-11 font-normal text-muted-foreground hover:bg-sidebar-accent hover:text-foreground focus-visible:text-foreground"
    >
      {more.expanded
        ? t("sidebar.showMore.showLess", "Show less")
        : t("sidebar.showMore.hiddenRows", "Show {{count}} more", { count: more.hiddenCount })}
    </Button>
  );
}
