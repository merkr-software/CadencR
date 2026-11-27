import { useUiTranslation } from "@/lib/i18n/ui";
import type { PluginTabSummary } from "@/api/generated";
import { useTabReplacementChoices } from "@/components/plugin-tabs/tab-replacement";
import {
  builtinTabLabel,
  declaredReplacements,
  NO_TAB_REPLACEMENTS,
  replacedBy,
} from "@/lib/plugin-tabs/tab-replacements";

/**
 * The built-ins a tab offers to replace, and the one it replaces now. Shown
 * only for a tab that offers one (`declaredReplacements`).
 */
export function CustomTabReplaces({
  tab,
}: {
  tab: Pick<PluginTabSummary, "id" | "label" | "replaces">;
}): React.JSX.Element {
  const { t, i18n } = useUiTranslation();
  const current = replacedBy(useTabReplacementChoices() ?? NO_TAB_REPLACEMENTS, tab.id);
  const offered = declaredReplacements(tab.replaces).map((slot) => builtinTabLabel(slot, t));
  return (
    <p className="text-xs leading-snug text-muted-foreground">
      {current
        ? t(
            "customTabs.replacements.activeReplacement",
            "Shown in place of {{builtin}} wherever it is on.",
            { builtin: builtinTabLabel(current, t) },
          )
        : t(
            "customTabs.replacements.offeredReplacements",
            "Can be shown in place of {{builtins}}.",
            {
              builtins: new Intl.ListFormat(i18n.language, { type: "disjunction" }).format(offered),
            },
          )}{" "}
      {t(
        "customTabs.replacements.chooseHint",
        "Choose in Replace built-in tabs, at the top of this page.",
      )}
    </p>
  );
}
