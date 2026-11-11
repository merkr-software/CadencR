import type { PluginTabSummary } from "@/api/generated";
import { useTabReplacementChoices } from "@/components/plugin-tabs/tab-replacement";
import {
  BUILTIN_TAB_LABELS,
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
  const current = replacedBy(useTabReplacementChoices() ?? NO_TAB_REPLACEMENTS, tab.id);
  const offered = declaredReplacements(tab.replaces).map((slot) => BUILTIN_TAB_LABELS[slot]);
  return (
    <p className="text-xs leading-snug text-muted-foreground">
      {current
        ? `Shown in place of ${BUILTIN_TAB_LABELS[current]} wherever it is on.`
        : `Can be shown in place of ${offered.join(" or ")}.`}{" "}
      Choose in Replace built-in tabs, at the top of this page.
    </p>
  );
}
