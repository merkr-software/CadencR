import { translateUi, useUiTranslation } from "@/lib/i18n/ui";
import { useEffect, useRef, useState, type MouseEvent, type ReactElement } from "react";
import { Check, Copy } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

interface CopyButtonProps {
  text: string;
  /** Accessible label and tooltip before copy. */
  label: string;
  /** Accessible label and tooltip after copy. Defaults to "Copied". */
  copiedLabel?: string;
  /** Tailwind class applied while copied. Defaults to "text-green-400". */
  copiedClassName?: string;
  /** Tailwind class applied while not copied. Defaults to "text-muted-foreground". */
  idleClassName?: string;
  /** Icon size class. Defaults to "size-3". */
  iconClassName?: string;
  className?: string;
}

export function CopyButton({
  text,
  label,
  copiedLabel,
  copiedClassName = "text-green-400",
  idleClassName = "text-muted-foreground",
  iconClassName = "size-3",
  className,
}: CopyButtonProps): ReactElement {
  const { t } = useUiTranslation();
  const [copied, setCopied] = useState(false);
  const copiedTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect((): (() => void) => {
    return () => {
      if (copiedTimeoutRef.current) {
        clearTimeout(copiedTimeoutRef.current);
      }
    };
  }, []);

  async function handleClick(event: MouseEvent<HTMLButtonElement>): Promise<void> {
    event.stopPropagation();

    try {
      await navigator.clipboard.writeText(text);
      if (!copied) {
        setCopied(true);
      }

      if (copiedTimeoutRef.current) {
        clearTimeout(copiedTimeoutRef.current);
      }

      copiedTimeoutRef.current = setTimeout((): void => {
        setCopied(false);
        copiedTimeoutRef.current = null;
      }, 1500);
    } catch {
      if (copiedTimeoutRef.current) {
        clearTimeout(copiedTimeoutRef.current);
        copiedTimeoutRef.current = null;
      }
      setCopied(false);
      toast.error(
        translateUi(
          "conversation.stream.copyButton.failedToCopyToClipboard",
          "Failed to copy to clipboard",
        ),
      );
    }
  }

  const currentLabel = copied ? (copiedLabel ?? t("common.copied", "Copied")) : label;

  return (
    <button
      type="button"
      aria-label={currentLabel}
      className={cn(
        "shrink-0 rounded px-0.5 transition-colors",
        className,
        copied ? copiedClassName : idleClassName,
      )}
      onClick={(event: MouseEvent<HTMLButtonElement>): void => {
        void handleClick(event);
      }}
      title={currentLabel}
    >
      {copied ? <Check className={iconClassName} /> : <Copy className={iconClassName} />}
    </button>
  );
}
