import { memo, useMemo, type ReactElement } from "react";
import { useSidebarAttention } from "@/components/sidebar-attention-context";
import { useUiTranslation } from "@/lib/i18n/ui";
import { isStrongAction } from "@/lib/next-actions";
import { cn } from "@/lib/utils";

/**
 * The phone menu button's count of For me entries (the sidebar's action list),
 * the conversation on screen left out: what waits elsewhere, so the user knows
 * the drawer and the inbox hold more. Amber when one is a pending request or a
 * failure, muted otherwise; nothing when there is none. A leaf: it re-renders
 * when the action list changes, never on a stream delta or a conversation switch.
 */
export const PhoneMenuAttentionDot = memo(function PhoneMenuAttentionDot({
  exceptFeatureId,
}: {
  exceptFeatureId: number | null;
}): ReactElement | null {
  const { t } = useUiTranslation();
  const { actions } = useSidebarAttention();
  const { count, strong } = useMemo(() => {
    const others = actions.filter((action) => action.feature.id !== exceptFeatureId);
    return { count: others.length, strong: others.some(isStrongAction) };
  }, [actions, exceptFeatureId]);
  if (count === 0) return null;
  return (
    <>
      <span
        aria-hidden
        data-phone-menu-attention={strong ? "strong" : "quiet"}
        className={cn(
          "pointer-events-none absolute top-1.5 right-1 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] leading-none font-semibold tabular-nums ring-2 ring-background",
          strong ? "bg-(--acc-yellow) text-black" : "bg-muted-foreground text-background",
        )}
      >
        {count > 9 ? "9+" : count}
      </span>
      <span className="sr-only">
        {t("phone.menu.attentionCount", {
          count,
          defaultValue_one: ", {{count}} for you",
          defaultValue_other: ", {{count}} for you",
        })}
      </span>
    </>
  );
});
