import { useUiTranslation } from "@/lib/i18n/ui";
/** Small green "Recommended" chip set beside an option's label. */
export function RecommendedTag(): React.JSX.Element {
  const { t } = useUiTranslation();
  return (
    <span className="rounded-sm border border-[var(--acc-green)] px-1 py-px text-[9px] font-semibold uppercase tracking-wide text-[var(--acc-green)]">
      {t("common.recommended", "Recommended")}
    </span>
  );
}
