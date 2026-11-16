import { useState, type ReactNode } from "react";
import { CodeIcon } from "lucide-react";
import { CodeBlockShell } from "@/components/CodeBlockShell";
import { CopyButton } from "@/components/CopyButton";
import { highlightCode } from "@/components/markdown/highlight-cache";
import { isLargeCodeBlock, LargeCodeBlock } from "@/components/markdown/LargeCodeBlock";
import { Button } from "@/components/ui/button";
import { SourceToggle } from "@/components/visuals/SourceToggle";

interface VisualFenceInfo {
  /** What the rendered view is called: "Chart", "Visual". */
  label: string;
  icon: ReactNode;
  code: string;
  /** Highlighting for the source view. */
  sourceLanguage: string;
}

/** A rendered fence's body, highlighted in `language`. */
export function VisualSource({ code, language }: { code: string; language: string }) {
  return (
    <pre className="overflow-x-auto p-3 text-xs leading-relaxed">
      <code className="hljs">{highlightCode(language, code) ?? code}</code>
    </pre>
  );
}

/** The fence as a regular code block (virtualized when large), with `actions` in its header. */
export function VisualSourceBlock({
  label,
  icon,
  code,
  sourceLanguage,
  actions,
}: VisualFenceInfo & { actions?: ReactNode }) {
  if (isLargeCodeBlock(code)) {
    return (
      <LargeCodeBlock
        language={label}
        icon={icon}
        code={code}
        showTerminalButton={false}
        leadingActions={actions}
      />
    );
  }
  return (
    <CodeBlockShell language={label} icon={icon} code={code} leadingActions={actions}>
      <VisualSource code={code} language={sourceLanguage} />
    </CodeBlockShell>
  );
}

/**
 * A rendered visual sits straight on the transcript, without a code-block
 * frame: its source and copy actions float over its corner on hover (always
 * shown on touch), and "Source" swaps it for the fence as a code block.
 */
export function VisualChrome({ children, ...fence }: VisualFenceInfo & { children: ReactNode }) {
  const [showSource, setShowSource] = useState(false);

  if (showSource) {
    return (
      <VisualSourceBlock
        {...fence}
        actions={
          <SourceToggle
            showingSource
            renderedLabel={fence.label}
            onToggle={() => setShowSource(false)}
          />
        }
      />
    );
  }

  return (
    <div data-visual className="group/visual relative my-2">
      <div className="absolute right-0 top-0 z-10 flex items-center gap-0.5 rounded-md border border-border bg-background/80 p-0.5 opacity-0 backdrop-blur-sm transition-opacity group-hover/visual:opacity-100 focus-within:opacity-100">
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={() => setShowSource(true)}
          title="View source"
          aria-label="View source"
        >
          <CodeIcon />
        </Button>
        <CopyButton
          text={fence.code}
          label="Copy source"
          className="flex size-6 items-center justify-center rounded-md hover:bg-accent hover:text-foreground"
        />
      </div>
      {children}
    </div>
  );
}
