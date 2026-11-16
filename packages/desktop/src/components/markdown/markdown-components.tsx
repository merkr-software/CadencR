import { lazy, Suspense, type ReactElement, type ReactNode, type RefObject } from "react";
import type { Components } from "streamdown";
import { CodeBlockShell } from "@/components/CodeBlockShell";
import { MarkdownImg } from "@/components/markdown-image";
import type { HastNode } from "@/components/markdown/agent-file-href-sanitize";
import { highlightCode } from "@/components/markdown/highlight-cache";
import { MarkdownLink } from "@/components/markdown/markdown-link";
import { LargeCodeBlock, isLargeCodeBlock } from "@/components/markdown/LargeCodeBlock";
import { VisualLoading } from "@/components/visuals/VisualStatus";

/** `load`, started at most once: its promise is shared by every caller. */
function once<T>(load: () => Promise<T>): () => Promise<T> {
  let started: Promise<T> | null = null;
  return () => (started ??= load());
}

const loadVegaLiteChart = once(() => import("@/components/visuals/VegaLiteChart"));
const loadHtmlVisual = once(() => import("@/components/visuals/HtmlVisual"));
const MermaidDiagram = lazy(() => import("@/components/MermaidDiagram"));
const VegaLiteChart = lazy(loadVegaLiteChart);
const HtmlVisual = lazy(loadHtmlVisual);

/**
 * Fences rendered as visuals once complete (the `/cadencr:visualize` skill
 * documents the last two). While streaming, a diagram shows as code,
 * highlighted as the language it is written in. A chart or visual instead
 * holds its place with a loader (`drafting`) — its source means little to
 * read and the rendered result replaces it — and fetches its renderer
 * meanwhile, so the result can paint as soon as the reply settles.
 */
// The service drops these same fences from a side question's excerpt
// (`side_question/excerpt.rs`, `RENDERED_FENCES`): keep both lists in step.
const RENDERED_FENCES = {
  mermaid: {
    highlight: "text",
    Component: MermaidDiagram,
    loading: "Loading diagram…",
    drafting: null,
  },
  "vega-lite": {
    highlight: "json",
    Component: VegaLiteChart,
    loading: "Loading chart renderer…",
    drafting: { label: "Writing chart…", preload: loadVegaLiteChart },
  },
  "cadencr-html": {
    highlight: "html",
    Component: HtmlVisual,
    loading: "Loading visual…",
    drafting: { label: "Writing visual…", preload: loadHtmlVisual },
  },
} as const;
type RenderedFence = keyof typeof RENDERED_FENCES;

function isRenderedFence(language: string): language is RenderedFence {
  return Object.hasOwn(RENDERED_FENCES, language);
}
const SHELL_LANGUAGES = new Set(["bash", "sh", "zsh", "shell", "console", "terminal"]);

function extractText(children: ReactNode): string {
  if (typeof children === "string") return children;
  if (typeof children === "number") return String(children);
  if (Array.isArray(children)) return children.map(extractText).join("");
  if (children && typeof children === "object" && "props" in children) {
    const element = children as React.ReactElement<{ children?: ReactNode }>;
    return extractText(element.props.children);
  }
  return "";
}

/**
 * Whether a link's label is images and nothing else: a badge. An icon beside
 * words (`<img> Open in X`) is still a text link and keeps its external mark.
 */
function isImageOnlyLabel(node: HastNode | undefined): boolean {
  const content = (node?.children ?? []).filter(
    (child) => child.type !== "text" || child.value?.trim(),
  );
  return (
    content.length > 0 &&
    content.every(
      (child) =>
        child.type === "element" && (child.tagName === "img" || child.tagName === "picture"),
    )
  );
}

function isFenceClosed(
  content: string,
  node?: { position?: { end?: { line?: number } } },
): boolean {
  const endLine = node?.position?.end?.line;
  if (endLine == null) return true;
  const lastLine = content.split("\n")[endLine - 1];
  return lastLine !== undefined && /^\s{0,3}(```|~~~)/.test(lastLine);
}

type FencePosition = { start?: { line?: number }; end?: { line?: number } };

/**
 * Lines written so far, from the fence's source position: counting them in
 * the text would rebuild the whole fence on every streamed delta. Includes the
 * closing line once written.
 */
function writtenLines(position: FencePosition | undefined): string {
  const lines = Math.max((position?.end?.line ?? 0) - (position?.start?.line ?? 0), 0);
  return lines === 1 ? "1 line" : `${lines} lines`;
}

/** Shown while a fence's renderer loads: bare for charts and visuals, in a code block for diagrams. */
function VisualFallback({
  language,
  code,
}: {
  language: RenderedFence;
  code: string;
}): ReactElement {
  const { drafting, loading } = RENDERED_FENCES[language];
  if (drafting) return <VisualLoading label={loading} />;
  return (
    <CodeBlockShell language={language} code={code}>
      <div className="p-3 text-xs text-muted-foreground">{loading}</div>
    </CodeBlockShell>
  );
}

interface MarkdownComponentOptions {
  contentRef: RefObject<string>;
  sendToTerminal?: (command: string) => void;
  isSettled: boolean;
  isStreaming: boolean;
  cacheHighlights?: boolean;
}

function buildCodeComponent({
  contentRef,
  sendToTerminal,
  isSettled,
  isStreaming,
  cacheHighlights = isSettled,
}: MarkdownComponentOptions): NonNullable<Components["code"]> {
  return ({ className, children, node, ...props }) => {
    const match = /language-([\w-]+)/.exec(className || "");
    const isBlock = node?.position && node.position.start.line !== node.position.end.line;
    if (match || isBlock) {
      const lang = match?.[1] ?? "text";
      const fence = isRenderedFence(lang) ? lang : null;
      // A settled reply with an unclosed fence was cut off: its code is all there is.
      const drafting = fence && !isSettled ? RENDERED_FENCES[fence].drafting : null;
      if (drafting) {
        void drafting.preload();
        return <VisualLoading label={drafting.label} detail={writtenLines(node?.position)} />;
      }
      const code = extractText(children).replace(/\n$/, "");
      if (fence && isSettled && isFenceClosed(contentRef.current, node)) {
        const { Component } = RENDERED_FENCES[fence];
        return (
          <Suspense fallback={<VisualFallback language={fence} code={code} />}>
            <Component code={code} />
          </Suspense>
        );
      }
      const highlightLanguage = fence ? RENDERED_FENCES[fence].highlight : lang;
      const showTerminalButton = SHELL_LANGUAGES.has(lang) && !!sendToTerminal;
      if (isLargeCodeBlock(code)) {
        return (
          <LargeCodeBlock
            language={lang}
            code={code}
            isStreaming={isStreaming}
            showTerminalButton={showTerminalButton}
            onSendToTerminal={sendToTerminal}
          />
        );
      }
      const highlighted =
        highlightCode(highlightLanguage, code, { cache: cacheHighlights }) ?? children;
      return (
        <CodeBlockShell
          language={lang}
          code={code}
          showTerminalButton={showTerminalButton}
          onSendToTerminal={sendToTerminal}
        >
          <pre className="overflow-x-auto p-3 text-xs leading-relaxed">
            <code className="hljs">{highlighted}</code>
          </pre>
        </CodeBlockShell>
      );
    }
    return (
      <code
        className="rounded bg-[color-mix(in_oklab,var(--acc-pink)_7%,transparent)] px-1 py-0.5 text-xs font-mono text-[color-mix(in_oklab,var(--acc-pink)_45%,var(--acc-purple))]"
        {...props}
      >
        {children}
      </code>
    );
  };
}

export function buildMarkdownComponents({
  contentRef,
  sendToTerminal,
  isSettled,
  isStreaming,
  cacheHighlights = isSettled,
}: MarkdownComponentOptions): Components {
  return {
    h1: ({ children }) => (
      <h1 className="text-2xl font-bold mt-5 mb-2 text-[var(--acc-purple)]">{children}</h1>
    ),
    h2: ({ children }) => (
      <h2 className="text-xl font-bold mt-4 mb-2 text-[var(--acc-cyan)]">{children}</h2>
    ),
    h3: ({ children }) => (
      <h3 className="text-lg font-semibold mt-3 mb-1.5 text-[var(--acc-green)]">{children}</h3>
    ),
    h4: ({ children }) => (
      <h4 className="text-base font-semibold mt-2 mb-1 text-[var(--acc-orange)]">{children}</h4>
    ),
    h5: ({ children }) => (
      <h5 className="text-sm font-semibold mt-2 mb-1 text-[var(--acc-pink)]">{children}</h5>
    ),
    h6: ({ children }) => (
      <h6 className="text-xs font-semibold mt-1 mb-0.5 text-[var(--acc-yellow)]">{children}</h6>
    ),
    code: buildCodeComponent({
      contentRef,
      sendToTerminal,
      isSettled,
      isStreaming,
      cacheHighlights,
    }),
    pre: ({ children }) => <>{children}</>,
    a: ({ href, children, node }) => (
      <MarkdownLink href={href} wrapsImage={isImageOnlyLabel(node)}>
        {children}
      </MarkdownLink>
    ),
    img: ({ src, alt, title, width, height }) => (
      <MarkdownImg src={src} alt={alt} title={title} width={width} height={height} />
    ),
    // A `<source srcset>` would make the browser load its remote URL and skip
    // the `<img>` — which the CSP blocks, and which `MarkdownImg` may route
    // through a proxy. Unwrap `<picture>` so only the `img` override loads.
    picture: ({ children }) => <>{children}</>,
    source: () => null,
    // Streamdown sets `text-sm` on these, undoing preflight's smaller size.
    sub: ({ children }) => <sub className="text-[0.8em]">{children}</sub>,
    sup: ({ children }) => <sup className="text-[0.8em]">{children}</sup>,
    table: ({ children }) => (
      <div className="my-2 overflow-x-auto">
        <table className="min-w-full border-collapse text-xs">{children}</table>
      </div>
    ),
    th: ({ children }) => (
      <th className="border border-border bg-muted px-2 py-1 text-left font-semibold">
        {children}
      </th>
    ),
    td: ({ children }) => <td className="border border-border px-2 py-1">{children}</td>,
    blockquote: ({ children }) => (
      <blockquote className="my-1 border-l-2 border-[var(--acc-comment)] pl-3 text-[var(--acc-comment)] italic">
        {children}
      </blockquote>
    ),
    ul: ({ children }) => <ul className="my-1 ps-[2em] list-disc space-y-0.5">{children}</ul>,
    ol: ({ children }) => <ol className="my-1 ps-[2em] list-decimal space-y-0.5">{children}</ol>,
    hr: () => <hr className="my-3 border-border" />,
    p: ({ children }) => <p className="my-1">{children}</p>,
  };
}
