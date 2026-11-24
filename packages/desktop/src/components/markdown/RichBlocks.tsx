import { useEffect, useMemo, useState, type ReactElement, type ReactNode } from "react";
import { TableIcon } from "lucide-react";
import { CodeBlockShell } from "@/components/CodeBlockShell";
import { useOpenDiffInEditor } from "@/components/diff/OpenDiffInEditorContext";
import { useLinkRouting } from "@/components/links/LinkRoutingContext";
import { RichExpandButton, RichPreviewFade } from "@/components/markdown/RichPreview";
import { useContentOverflow } from "@/hooks/useContentOverflow";
import { useIsMobile } from "@/hooks/useIsMobile";
import { cn } from "@/lib/utils";
import {
  openRichViewer,
  refreshRichViewer,
  type RichViewerContent,
} from "@/stores/rich-viewer-store";

/**
 * Opens `viewer` in the root viewer (`RichContentViewerHost`) with the
 * message's link actions, and keeps it current while the block streams and
 * the viewer it opened is still on screen.
 */
function useRichViewerOpener(viewer: RichViewerContent): () => void {
  const [owner] = useState(() => ({}));
  const routing = useLinkRouting();
  const openInEditor = useOpenDiffInEditor();
  useEffect(() => refreshRichViewer(owner, viewer), [owner, viewer]);
  return () => openRichViewer(owner, viewer, { routing, openInEditor });
}

/**
 * A message's table: scrolls sideways in its own box on the desktop layout;
 * on the phone layout one wider than the column is a clipped preview with
 * Expand (`RichPreview.tsx`), and one that fits renders as it is.
 */
export function MarkdownTable({ children }: { children?: ReactNode }): ReactElement {
  if (useIsMobile()) return <PhoneMarkdownTable>{children}</PhoneMarkdownTable>;
  return (
    <div className="my-2 overflow-x-auto">
      <table className="min-w-full border-collapse text-xs">{children}</table>
    </div>
  );
}

function PhoneMarkdownTable({ children }: { children?: ReactNode }): ReactElement {
  const { ref, wide, tall } = useContentOverflow(true);
  const viewer = useMemo<RichViewerContent>(
    () => ({
      kind: "table",
      title: "Table",
      content: (
        <table className="min-w-full border-collapse text-xs [&_td]:min-w-40 [&_th]:min-w-40">
          {children}
        </table>
      ),
    }),
    [children],
  );
  const openViewer = useRichViewerOpener(viewer);
  return (
    <div
      data-rich-table={wide ? "preview" : "inline"}
      className={cn("my-2", wide && "overflow-hidden rounded-md border border-border bg-muted/50")}
    >
      {wide && (
        <div className="flex h-11 items-center gap-1.5 border-b border-border bg-muted pl-3 text-xs text-muted-foreground">
          <TableIcon className="size-3" aria-hidden />
          <span className="flex-1">Table</span>
          <RichExpandButton label="Expand table" onClick={openViewer} />
        </div>
      )}
      <div className="relative">
        <div ref={ref} className={cn("overflow-hidden", wide && "max-h-60")}>
          <table className="min-w-full border-collapse text-xs">{children}</table>
        </div>
        {wide && <RichPreviewFade wide tall={tall} />}
      </div>
    </div>
  );
}

interface MarkdownCodeBlockProps {
  language: string;
  code: string;
  /** The highlighted tokens (or the raw children). */
  highlighted: ReactNode;
  showTerminalButton: boolean;
  onSendToTerminal?: (command: string) => void;
}

/**
 * A fenced code block under the large-block threshold. Desktop: a box that
 * scrolls sideways. Phone: one that fits renders the same, without the inner
 * scroll; a wider one is a clipped preview with Expand in its header.
 */
export function MarkdownCodeBlock(props: MarkdownCodeBlockProps): ReactElement {
  const phone = useIsMobile();
  if (phone) return <PhoneMarkdownCodeBlock {...props} />;
  const { language, code, highlighted, showTerminalButton, onSendToTerminal } = props;
  return (
    <CodeBlockShell
      language={language}
      code={code}
      showTerminalButton={showTerminalButton}
      onSendToTerminal={onSendToTerminal}
    >
      <pre className="overflow-x-auto p-3 text-xs leading-relaxed">
        <code className="hljs">{highlighted}</code>
      </pre>
    </CodeBlockShell>
  );
}

function PhoneMarkdownCodeBlock({
  language,
  code,
  highlighted,
  showTerminalButton,
  onSendToTerminal,
}: MarkdownCodeBlockProps): ReactElement {
  const { ref, wide, tall } = useContentOverflow(true);
  const viewer = useMemo<RichViewerContent>(
    () => ({
      kind: "code",
      title: language,
      code,
      content: (
        <pre className="font-mono text-xs leading-relaxed">
          <code className="hljs">{highlighted}</code>
        </pre>
      ),
    }),
    [code, highlighted, language],
  );
  const openViewer = useRichViewerOpener(viewer);
  return (
    <CodeBlockShell
      language={language}
      code={code}
      showTerminalButton={showTerminalButton}
      onSendToTerminal={onSendToTerminal}
      leadingActions={
        wide ? (
          <RichExpandButton label={`Expand ${language} code`} onClick={openViewer} />
        ) : undefined
      }
    >
      <div className="relative" data-rich-code={wide ? "preview" : "inline"}>
        <pre
          ref={ref}
          className={cn("overflow-hidden p-3 text-xs leading-relaxed", wide && "max-h-60")}
        >
          {/* A block as wide as its longest line (never narrower than the
              box): the overflow watch sees it grow when a streamed line only
              gets longer, which an inline `<code>` would not report. */}
          <code className="hljs block w-max min-w-full">{highlighted}</code>
        </pre>
        {wide && <RichPreviewFade wide tall={tall} />}
      </div>
    </CodeBlockShell>
  );
}
