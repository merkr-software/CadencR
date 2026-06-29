import type { ReactNode } from "react";
import { CodeBlockHeader } from "@/components/CodeBlockHeader";

interface CodeBlockShellProps {
  language: string;
  code: string;
  showTerminalButton?: boolean;
  onSendToTerminal?: (command: string) => void;
  /** Extra actions rendered in the header's action row, before the copy button. */
  leadingActions?: ReactNode;
  children: ReactNode;
}

/** Bordered card + header chrome shared by code blocks and mermaid diagrams. */
export function CodeBlockShell({ children, ...header }: CodeBlockShellProps) {
  return (
    <div className="my-1 rounded-md border border-border bg-muted/50 overflow-hidden group/codeblock">
      <CodeBlockHeader {...header} />
      {children}
    </div>
  );
}
