import { useUiTranslation } from "@/lib/i18n/ui";
import { useState, useCallback, type ReactNode } from "react";
import { CodeIcon, CopyIcon, CheckIcon, TerminalIcon } from "lucide-react";

/** A header action; 44px tall and wide on the phone layout. */
export const HEADER_BUTTON_CLASS =
  "flex items-center gap-1 rounded px-1.5 py-0.5 text-foreground/70 hover:bg-accent hover:text-foreground transition-colors phone:h-11 phone:min-w-11 phone:justify-center";

interface CodeBlockHeaderProps {
  language: string;
  /** Replaces the code glyph in front of the label. */
  icon?: ReactNode;
  code: string;
  showTerminalButton?: boolean;
  onSendToTerminal?: (command: string) => void;
  /** Extra actions rendered in the header's action row, before the copy button. */
  leadingActions?: ReactNode;
}

export function CodeBlockHeader({
  language,
  icon,
  code,
  showTerminalButton,
  onSendToTerminal,
  leadingActions,
}: CodeBlockHeaderProps) {
  const { t } = useUiTranslation();
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [code]);

  const handleSendToTerminal = useCallback(() => {
    // Write the command followed by newline to execute it
    onSendToTerminal?.(code + "\n");
  }, [code, onSendToTerminal]);

  return (
    // Phone layout: a 44px row whose buttons are as tall (DESIGN.md "Hit areas
    // on phone"); the card's `overflow: hidden` would clip a `hit-area`.
    <div className="flex items-center gap-1.5 border-b border-border bg-muted px-3 py-1 text-xs text-muted-foreground phone:h-11 phone:py-0 phone:pr-1">
      {icon ?? <CodeIcon className="size-3" />}
      <span className="flex-1">{language}</span>
      <div className="flex items-center gap-0.5">
        {leadingActions}
        {showTerminalButton && (
          <button
            type="button"
            onClick={handleSendToTerminal}
            className={HEADER_BUTTON_CLASS}
            title={t("conversation.stream.codeBlockHeader.runInTerminal", "Run in terminal")}
          >
            <TerminalIcon className="size-3" />
            <span>{t("conversation.stream.codeBlockHeader.run", "Run")}</span>
          </button>
        )}
        <button
          type="button"
          onClick={handleCopy}
          className={HEADER_BUTTON_CLASS}
          title={t("conversation.stream.codeBlockHeader.copyToClipboard", "Copy to clipboard")}
        >
          {copied ? (
            <>
              <CheckIcon className="size-3 text-green-400" />
              <span className="text-green-400">
                {t("conversation.stream.codeBlockHeader.copied", "Copied")}
              </span>
            </>
          ) : (
            <>
              <CopyIcon className="size-3" />
              <span>{t("conversation.stream.codeBlockHeader.copy", "Copy")}</span>
            </>
          )}
        </button>
      </div>
    </div>
  );
}
