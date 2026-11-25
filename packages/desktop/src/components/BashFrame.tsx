import { useUiTranslation } from "@/lib/i18n/ui";
import type { ReactNode } from "react";
import { TerminalIcon } from "lucide-react";

import { cn } from "@/lib/utils";

interface BashFrameProps {
  /** Optional content rendered after the "Bash" label (e.g. a hint or count). */
  headerTrailing?: ReactNode;
  /** Terminal body content — e.g. a command editor or rendered output. */
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}

/**
 * Terminal "bash block" chrome: a header bar with the terminal glyph + "Bash"
 * label over a dark body, using the same `--block-bash-*` tokens as the
 * read-only {@link BashBlock} output. Shared so editing a command and viewing
 * its output read as the same terminal surface. Unlike `BashBlock` this is a
 * plain frame (no collapse/ANSI), so it can wrap editable inputs.
 */
export function BashFrame({
  headerTrailing,
  children,
  className,
  bodyClassName,
}: BashFrameProps): ReactNode {
  const { t } = useUiTranslation();
  return (
    <div className={cn("overflow-hidden rounded-md border border-border", className)}>
      <div className="flex items-center gap-2 bg-[var(--block-bash-header-bg)] px-3 py-1.5 text-xs text-[var(--block-bash-muted-fg)]">
        <TerminalIcon className="size-3 shrink-0" />
        <span className="font-medium text-[var(--block-bash-fg)]">
          {t("conversation.stream.bashFrame.bash", "Bash")}
        </span>
        {headerTrailing}
      </div>
      <div
        data-bash-body
        className={cn("bg-[var(--block-bash-body-bg)] text-[var(--block-bash-fg)]", bodyClassName)}
      >
        {children}
      </div>
    </div>
  );
}
