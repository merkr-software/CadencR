import { useUiTranslation, type UiTranslator } from "@/lib/i18n/ui";
/**
 * Status-bar notice for a workbook whose formula results Cadencr computed
 * (the file was saved without them — openpyxl / xlsxwriter output). Tells the
 * reader the values come from IronCalc, not Excel, and flags any it couldn't
 * compute.
 */
import type { ReactElement } from "react";
import { SigmaIcon, TriangleAlertIcon } from "lucide-react";
import { ShortcutTooltip } from "@/components/ShortcutTooltip";
import type { FormulaRecalc } from "@/lib/document-file";
import { cn } from "@/lib/utils";

function formulaCount(count: number, t: UiTranslator): string {
  return t("workspace.editor.formulaRecalcNotice.formulaCount", {
    count,
    defaultValue_one: "{{count, number}} formula",
    defaultValue_other: "{{count, number}} formulas",
  });
}

function describe(
  formulas: FormulaRecalc,
  t: UiTranslator,
): {
  label: string;
  detail: string;
  warn: boolean;
} {
  if (formulas.status === "failed") {
    return {
      label: t("workspace.editor.formulaRecalcNotice.failed", "Formulas not calculated"),
      detail: t(
        "workspace.editor.formulaRecalcNotice.failedDetail",
        "This workbook was saved without its formula results, as scripts like openpyxl write them. Cadencr couldn't calculate them: {{reason}}. Cells show what the file saved.",
        { reason: formulas.reason },
      ),
      warn: true,
    };
  }
  const { computed, unresolved } = formulas;
  const calculated = formulaCount(computed, t);
  if (unresolved > 0) {
    return {
      label: t("workspace.editor.formulaRecalcNotice.unresolved", {
        count: unresolved,
        defaultValue_one: "{{count, number}} formula not calculated",
        defaultValue_other: "{{count, number}} formulas not calculated",
      }),
      detail: t("workspace.editor.formulaRecalcNotice.unresolvedDetail", {
        count: unresolved,
        calculated,
        defaultValue_one:
          "This workbook was saved without its formula results, as scripts like openpyxl write them. Cadencr calculated {{calculated}}; {{count, number}} formula uses a function or syntax its formula engine doesn't support and shows what the file saved.",
        defaultValue_other:
          "This workbook was saved without its formula results, as scripts like openpyxl write them. Cadencr calculated {{calculated}}; {{count, number}} formulas use functions or syntax its formula engine doesn't support and show what the file saved.",
      }),
      warn: true,
    };
  }
  return {
    label: t("workspace.editor.formulaRecalcNotice.calculated", "Calculated by Cadencr"),
    detail: t(
      "workspace.editor.formulaRecalcNotice.calculatedDetail",
      "This workbook was saved without its formula results, as scripts like openpyxl write them. Cadencr calculated its {{calculated}}; Excel may differ on rare functions.",
      { calculated },
    ),
    warn: false,
  };
}

export function FormulaRecalcNotice({ formulas }: { formulas: FormulaRecalc }): ReactElement {
  const { t } = useUiTranslation();
  const { label, detail, warn } = describe(formulas, t);
  const Icon = warn ? TriangleAlertIcon : SigmaIcon;
  return (
    <ShortcutTooltip label={label} content={<span className="block max-w-xs">{detail}</span>}>
      <span
        tabIndex={0}
        role={warn ? "status" : undefined}
        aria-label={t(
          "workspace.editor.formulaRecalcNotice.accessibleSummary",
          "{{label}}. {{detail}}",
          { label, detail },
        )}
        className={cn(
          "mr-1 flex shrink-0 cursor-default items-center gap-1 rounded-sm outline-none focus-visible:ring-1 focus-visible:ring-ring",
          warn && "text-amber-600 dark:text-amber-300",
        )}
      >
        <Icon className="size-3.5" />
        {label}
      </span>
    </ShortcutTooltip>
  );
}
