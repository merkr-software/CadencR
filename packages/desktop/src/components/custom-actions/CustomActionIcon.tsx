import type { ReactElement } from "react";

import { cn } from "@/lib/utils";
import { actionMonogram, isImageIcon, lucideIconFor } from "./action-icons";

interface CustomActionIconProps {
  iconData: string | null | undefined;
  name: string;
  className?: string;
}

/**
 * An action's mark: a chosen glyph, an uploaded image, or else a monogram of
 * its name — never one shared generic glyph, so actions stay tellable apart
 * at a glance. Decorative: the action's name is always rendered beside it.
 */
export function CustomActionIcon({
  iconData,
  name,
  className,
}: CustomActionIconProps): ReactElement {
  const Glyph = lucideIconFor(iconData);
  if (Glyph) return <Glyph aria-hidden className={cn("size-3.5 shrink-0", className)} />;
  if (isImageIcon(iconData)) {
    return (
      <img src={iconData} alt="" className={cn("size-3.5 shrink-0 object-contain", className)} />
    );
  }
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex size-3.5 shrink-0 items-center justify-center rounded-[3px] bg-muted text-[8px] leading-none font-semibold tracking-tight text-muted-foreground",
        className,
      )}
    >
      {actionMonogram(name)}
    </span>
  );
}
