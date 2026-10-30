import { memo, useCallback, useMemo, useRef, useState } from "react";
import { CheckIcon, CopyIcon } from "lucide-react";
import { Markdown } from "@/components/Markdown";
import { CodeBlockHeader } from "@/components/CodeBlockHeader";
import { useCodeBlockActions } from "@/components/CodeBlockActionsContext";
import { CopyAsMenu } from "@/components/agent-session/CopyAsMenu";
import { useStreamingMarkdownThrottle } from "@/hooks/useStreamingMarkdownThrottle";
import { copyAs } from "@/lib/markdown-export";

/** Render the final text output from an Agent/Task tool_result (JSON content blocks). */
export function AgentResultBlock({
  content,
  actions = true,
}: {
  content: string;
  actions?: boolean;
}) {
  const text = useMemo(() => {
    try {
      const blocks = JSON.parse(content) as Array<{
        type?: string;
        text?: string;
      }>;
      return blocks
        .filter((b) => b.type === "text" || (!b.type && typeof b.text === "string"))
        .map((b) => b.text ?? "")
        .join("\n");
    } catch {
      return content;
    }
  }, [content]);
  if (!text) return null;
  return <TextBlock content={text} actions={actions} />;
}

export const TextBlock = memo(function TextBlock({
  content,
  cacheKey,
  isStreaming,
  disableCache,
  actions = true,
}: {
  content: string;
  cacheKey?: string;
  isStreaming?: boolean;
  disableCache?: boolean;
  /** Off for a truncated preview: copying it would copy cut content. */
  actions?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  // Throttle re-parse of the actively streaming block; copy always uses the
  // full latest content.
  const displayContent = useStreamingMarkdownThrottle(content, !!isStreaming);

  const handleCopy = useCallback(() => {
    void copyAs("markdown", content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [content]);

  return (
    <div className="group/textblock" ref={rootRef}>
      <Markdown
        content={displayContent}
        cacheKey={cacheKey}
        isStreaming={isStreaming}
        disableCache={disableCache}
      />
      {actions && (
        <div className="flex items-center gap-1 opacity-0 group-hover/textblock:opacity-100 transition-colors">
          <button
            type="button"
            onClick={handleCopy}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-foreground/70 hover:bg-accent hover:text-foreground transition-colors"
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
          {!isStreaming && <CopyAsMenu content={content} sourceRef={rootRef} />}
        </div>
      )}
    </div>
  );
});

const SHELL_LANGUAGES = new Set(["bash", "sh", "zsh", "shell", "console", "terminal"]);

export function CodeBlock({ content, language }: { content: string; language?: string }) {
  const { sendToTerminal } = useCodeBlockActions();
  const isShell = !!language && SHELL_LANGUAGES.has(language);

  return (
    <div
      data-code-block
      className="my-1 rounded-md border border-border bg-muted/50 overflow-hidden group/codeblock"
    >
      {language && (
        <CodeBlockHeader
          language={language}
          code={content}
          showTerminalButton={isShell && !!sendToTerminal}
          onSendToTerminal={sendToTerminal}
        />
      )}
      <pre className="overflow-x-auto p-3 text-xs leading-relaxed">
        <code>{content}</code>
      </pre>
    </div>
  );
}
