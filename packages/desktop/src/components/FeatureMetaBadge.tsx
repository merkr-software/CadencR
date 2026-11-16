import type { ReactElement, ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

interface FeatureMetaBadgeProps {
  icon: ReactElement;
  children: ReactNode;
  /** Accessible label and tooltip. Omit when an ancestor already labels it. */
  label?: string;
  className?: string;
}

/**
 * One chip on a sidebar conversation's meta line — shell counts, browser tabs,
 * listening ports. Shared so the row's chips stay visually identical; only the
 * text colour is ever varied here ("Colors: Increased" also lets a count shed
 * its box, `sidebar-row-colors.css`).
 */
export function FeatureMetaBadge({
  icon,
  children,
  label,
  className,
}: FeatureMetaBadgeProps): ReactElement {
  return (
    <Badge
      variant="outline"
      aria-label={label}
      title={label}
      className={cn(
        "h-5 gap-0.5 rounded border-border/60 bg-background/40 px-1 font-mono text-[10px] leading-none text-muted-foreground",
        className,
      )}
    >
      {icon}
      {children}
    </Badge>
  );
}
