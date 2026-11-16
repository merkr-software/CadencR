import type { ReactElement } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * A short explanation shown on hover and keyboard focus. Needs a
 * `TooltipProvider` above it, one per screen so neighbouring hints open
 * without the delay once one is showing.
 */
export function HintTooltip({
  hint,
  align = "center",
  children,
}: {
  hint: string;
  align?: "start" | "center";
  children: ReactElement;
}): ReactElement {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="top" align={align} className="max-w-64">
        {hint}
      </TooltipContent>
    </Tooltip>
  );
}
