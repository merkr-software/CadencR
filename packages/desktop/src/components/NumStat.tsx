/**
 * Shared `+A` / `-D` git numstat badge.
 *
 * Theme tokens intentionally live outside the editor palette so future themes
 * can tune diff counters without changing syntax highlighting contrast.
 */
import { type ReactElement } from "react";
import { cn } from "@/lib/utils";

export interface NumStatProps {
  additions: number | null | undefined;
  deletions: number | null | undefined;
  /** Hide each side when its count is zero (default `true`). */
  hideZero?: boolean;
  /** Optional visible separator rendered between both values. */
  separator?: string;
  /** Override the additions color (defaults to `--numstat-add-fg`). */
  addColor?: string;
  /** Override the deletions color (defaults to `--numstat-del-fg`). */
  delColor?: string;
  className?: string;
}

export function NumStat({
  additions,
  deletions,
  hideZero = true,
  separator,
  addColor,
  delColor,
  className,
}: NumStatProps): ReactElement | null {
  const adds = additions ?? 0;
  const dels = deletions ?? 0;
  if (hideZero && adds === 0 && dels === 0) return null;

  const showAdds = !hideZero || adds > 0;
  const showDels = !hideZero || dels > 0;
  return (
    <span className={cn("inline-flex items-center gap-1.5 font-mono tabular-nums", className)}>
      {showAdds && <span style={{ color: addColor ?? "var(--numstat-add-fg)" }}>+{adds}</span>}
      {showAdds && showDels && separator != null && (
        <span className="text-muted-foreground">{separator}</span>
      )}
      {showDels && <span style={{ color: delColor ?? "var(--numstat-del-fg)" }}>-{dels}</span>}
    </span>
  );
}
