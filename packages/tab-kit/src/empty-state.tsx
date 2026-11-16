/**
 * Kit-native: desktop draws empty states inline per surface. A centered
 * column — muted icon, 14px semibold title, muted 12px description, optional
 * action — for a tab with nothing to show yet.
 */
import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/utils";

interface EmptyStateProps extends Omit<ComponentProps<"div">, "title"> {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}

function EmptyState({ icon, title, description, action, className, ...props }: EmptyStateProps) {
  return (
    <div
      data-slot="empty-state"
      className={cn(
        "flex flex-col items-center justify-center gap-2 px-6 py-10 text-center",
        className,
      )}
      {...props}
    >
      {icon ? (
        <div className="mb-1 text-muted-foreground [&_svg:not([class*='size-'])]:size-6">
          {icon}
        </div>
      ) : null}
      <h3 className="text-sm leading-tight font-semibold">{title}</h3>
      {description ? (
        <p className="max-w-sm text-xs leading-snug text-muted-foreground">{description}</p>
      ) : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

export { EmptyState, type EmptyStateProps };
