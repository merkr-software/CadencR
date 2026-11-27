import type { ReactElement, ReactNode } from "react";
import { TerminalIcon } from "lucide-react";
import { useUiTranslation } from "@/lib/i18n/ui";
import { cn } from "@/lib/utils";

interface ShellTerminalFrameProps {
  children: ReactNode;
  title?: string;
  subtitle?: string;
  className?: string;
  bodyClassName?: string;
}

export function ShellTerminalFrame({
  children,
  title,
  subtitle,
  className,
  bodyClassName,
}: ShellTerminalFrameProps): ReactElement {
  const { t } = useUiTranslation();
  // Editable shell surfaces use the same lighter command strip and black
  // body tokens as the canonical conversation `BashBlock`.
  return (
    <div
      className={cn(
        "overflow-hidden rounded-md border border-border bg-[var(--block-bash-body-bg)]",
        className,
      )}
    >
      <div className="flex items-center gap-2 bg-[var(--block-bash-header-bg)] px-3 py-1 text-xs text-[var(--block-bash-muted-fg)]">
        <TerminalIcon className="size-3 shrink-0" />
        <span className="font-medium text-[var(--block-bash-fg)]">
          {title ?? t("workspace.tools.shellTerminalFrame.shell", "Shell")}
        </span>
        {subtitle && (
          <span className="min-w-0 truncate text-[var(--block-bash-muted-fg)]">{subtitle}</span>
        )}
      </div>
      <div className={cn("bg-[var(--block-bash-body-bg)]", bodyClassName)}>{children}</div>
    </div>
  );
}
