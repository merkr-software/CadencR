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

const SAVED_WITHOUT_RESULTS =
  "This workbook was saved without its formula results, as scripts like openpyxl write them.";

function formulaCount(count: number): string {
  return `${count.toLocaleString()} formula${count === 1 ? "" : "s"}`;
}

function describe(formulas: FormulaRecalc): { label: string; detail: string; warn: boolean } {
  if (formulas.status === "failed") {
    return {
      label: "Formulas not calculated",
      detail: `${SAVED_WITHOUT_RESULTS} Cadencr couldn't calculate them: ${formulas.reason}. Cells show what the file saved.`,
      warn: true,
    };
  }
  const { computed, unresolved } = formulas;
  if (unresolved > 0) {
    return {
      label: `${formulaCount(unresolved)} not calculated`,
      detail: `${SAVED_WITHOUT_RESULTS} Cadencr calculated ${formulaCount(computed)}; ${formulaCount(unresolved)} ${unresolved === 1 ? "uses a function or syntax its formula engine doesn't support and shows" : "use functions or syntax its formula engine doesn't support and show"} what the file saved.`,
      warn: true,
    };
  }
  return {
    label: "Calculated by Cadencr",
    detail: `${SAVED_WITHOUT_RESULTS} Cadencr calculated its ${formulaCount(computed)}; Excel may differ on rare functions.`,
    warn: false,
  };
}

export function FormulaRecalcNotice({ formulas }: { formulas: FormulaRecalc }): ReactElement {
  const { label, detail, warn } = describe(formulas);
  const Icon = warn ? TriangleAlertIcon : SigmaIcon;
  return (
    <ShortcutTooltip label={label} content={<span className="block max-w-xs">{detail}</span>}>
      <span
        tabIndex={0}
        role={warn ? "status" : undefined}
        aria-label={`${label}. ${detail}`}
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
