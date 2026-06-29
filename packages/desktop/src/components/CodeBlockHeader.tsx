import { useState, useCallback, type ReactNode } from "react";
import { CodeIcon, CopyIcon, CheckIcon, TerminalIcon } from "lucide-react";

interface CodeBlockHeaderProps {
  language: string;
  code: string;
  showTerminalButton?: boolean;
  onSendToTerminal?: (command: string) => void;
  /** Extra actions rendered in the header's action row, before the copy button. */
  leadingActions?: ReactNode;
}

export function CodeBlockHeader({
  language,
  code,
  showTerminalButton,
  onSendToTerminal,
  leadingActions,
}: CodeBlockHeaderProps) {
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
    <div className="flex items-center gap-1.5 border-b border-border bg-muted px-3 py-1 text-xs text-muted-foreground">
      <CodeIcon className="size-3" />
      <span className="flex-1">{language}</span>
      <div className="flex items-center gap-0.5">
        {leadingActions}
        {showTerminalButton && (
          <button
            type="button"
            onClick={handleSendToTerminal}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-foreground/70 hover:bg-accent hover:text-foreground transition-colors"
            title="Run in terminal"
          >
            <TerminalIcon className="size-3" />
            <span>Run</span>
          </button>
        )}
        <button
          type="button"
          onClick={handleCopy}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-foreground/70 hover:bg-accent hover:text-foreground transition-colors"
          title="Copy to clipboard"
        >
          {copied ? (
            <>
              <CheckIcon className="size-3 text-green-400" />
              <span className="text-green-400">Copied</span>
            </>
          ) : (
            <>
              <CopyIcon className="size-3" />
              <span>Copy</span>
            </>
          )}
        </button>
      </div>
    </div>
  );
}
