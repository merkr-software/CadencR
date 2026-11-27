import { useUiTranslation } from "@/lib/i18n/ui";
import type { ReactElement } from "react";
import { CopyButton as SharedCopyButton } from "@/components/CopyButton";
import { cn } from "@/lib/utils";

interface CopyButtonProps {
  text: string;
  label?: string;
  copiedLabel?: string;
  /** Tailwind class applied while not copied. Defaults to header group hover visibility. */
  hoverClass?: string;
  /** Icon size class. Defaults to "h-3 w-3". */
  sizeClass?: string;
  className?: string;
}

export function CopyButton({
  text,
  label,
  copiedLabel,
  hoverClass = "opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
  sizeClass = "h-3 w-3",
  className,
}: CopyButtonProps): ReactElement {
  const { t } = useUiTranslation();
  return (
    <SharedCopyButton
      text={text}
      label={label ?? t("workspace.git.copyButton.copyPath", "Copy path")}
      copiedLabel={copiedLabel ?? t("workspace.git.copyButton.copied", "Copied")}
      className={cn("hover:text-foreground", className)}
      copiedClassName="text-[var(--acc-green)]"
      idleClassName={cn("text-muted-foreground", hoverClass)}
      iconClassName={sizeClass}
    />
  );
}
