import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

import type { FeatureTabDef } from "./types";

/** A tab's icon in a trigger or drag chip, from either icon source. */
export function FeatureTabIcon({
  def,
  className,
}: {
  def: FeatureTabDef;
  className?: string;
}): ReactNode {
  if (def.Icon) return <def.Icon className={cn("size-4 shrink-0", className)} />;
  return (
    <span
      aria-hidden
      className={cn("inline-flex size-4 shrink-0 items-center justify-center", className)}
    >
      {def.iconNode}
    </span>
  );
}
