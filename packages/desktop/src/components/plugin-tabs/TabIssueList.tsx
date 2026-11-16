import type { ReactNode } from "react";

import type { TabIssue } from "@/api/generated";
import { cn } from "@/lib/utils";

/**
 * Manifest validation findings, each with its stable code (so it can be
 * looked up or grepped) and the field it concerns. Shared by the tab's own
 * overlay and its Settings card so the two never drift apart.
 */
export function TabIssueList({
  issues,
  className,
}: {
  issues: readonly TabIssue[];
  className?: string;
}): ReactNode {
  if (issues.length === 0) return null;
  return (
    <ul className={cn("space-y-1.5 text-left", className)}>
      {issues.map((issue, index) => (
        <li key={`${issue.code}-${index}`} className="text-[11.5px] leading-snug">
          <span className="font-mono text-[10.5px] text-foreground/80">{issue.code}</span>
          {issue.field ? (
            <span className="font-mono text-[10.5px] text-muted-foreground"> · {issue.field}</span>
          ) : null}
          <span className="block text-muted-foreground">{issue.message}</span>
        </li>
      ))}
    </ul>
  );
}
