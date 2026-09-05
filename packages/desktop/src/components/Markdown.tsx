import { memo, lazy, Suspense, useMemo, useRef, useState, type ReactElement } from "react";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import {
  Streamdown,
  defaultUrlTransform,
  type AnimateOptions,
  type Components,
  type StreamdownProps,
  type UrlTransform,
} from "streamdown";
import "streamdown/styles.css";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import { Loader2Icon } from "lucide-react";
import { createLowlight, common } from "lowlight";
import ini from "highlight.js/lib/languages/ini";
import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import { cn } from "@/lib/utils";
import { MarkdownImg } from "@/components/markdown-image";
import { CodeBlockShell } from "@/components/CodeBlockShell";
import { useCodeBlockActions } from "@/components/CodeBlockActionsContext";
import { useLinkRouting, type LinkRouting } from "@/components/links/LinkRoutingContext";
import { parseConversationReferenceHref } from "@/components/prompt-editor/conversation-reference";
import { parseFileReferenceHref } from "@/components/prompt-editor/file-reference";
import { fileReferenceRemarkPlugin } from "@/components/prompt-editor/file-reference-remark-plugin";
import { useOpenDiffInEditor } from "@/components/diff/OpenDiffInEditorContext";
import { defaultRemarkPlugins } from "streamdown";
import "./dracula-highlight.css";

type RehypePlugins = NonNullable<StreamdownProps["rehypePlugins"]>;

const LINK_CLASS =
  "text-[var(--acc-cyan)] underline underline-offset-2 hover:text-[var(--acc-purple)]";

/**
 * Anchor renderer for agent-chat markdown. Inside a feature, links route
 * through the shared link layer: Cmd/Ctrl+Click opens via the domain policy,
 * plain click is inert (preserves text selection), and hovering feeds the
 * native right-click menu its open choices. Rendered outside a feature (e.g.
 * the changelog dialog) it falls back to the previous open-in-new-tab anchor.
 */
function MarkdownLink({
  href,
  children,
}: {
  href?: string;
  children: React.ReactNode;
}): ReactElement {
  const routing = useLinkRouting();
  const openInEditor = useOpenDiffInEditor();
  const fileReference = href ? parseFileReferenceHref(href) : null;
  if (href && fileReference !== null) {
    return (
      <FileReferenceLink reference={fileReference} openInEditor={openInEditor}>
        {children}
      </FileReferenceLink>
    );
  }
  const conversationFeatureId = href ? parseConversationReferenceHref(href) : null;
  if (href && conversationFeatureId !== null) {
    return (
      <ConversationReferenceLink featureId={conversationFeatureId} href={href} routing={routing}>
        {children}
      </ConversationReferenceLink>
    );
  }
  if (!routing || !href) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" className={LINK_CLASS}>
        {children}
      </a>
    );
  }
  return (
    <a
      href={href}
      rel="noopener noreferrer"
      className={LINK_CLASS}
      onClick={(event) => {
        event.preventDefault();
        if (event.metaKey || event.ctrlKey) routing.activate(href);
      }}
      onMouseEnter={() => routing.setHoverLink(href)}
      onMouseLeave={() => routing.setHoverLink(null)}
    >
      {children}
    </a>
  );
}

function ConversationReferenceLink({
  featureId,
  href,
  routing,
  children,
}: {
  featureId: number;
  href: string;
  routing: LinkRouting | null;
  children: React.ReactNode;
}): ReactElement {
  const [isOpening, setIsOpening] = useState(false);
  return (
    <a
      href={href}
      aria-busy={isOpening}
      className="rounded-sm font-semibold text-[var(--chip-fuchsia-fg)] underline decoration-[var(--chip-fuchsia-fg)]/50 underline-offset-2 hover:bg-[var(--chip-fuchsia-bg)]/15 hover:decoration-[var(--chip-fuchsia-fg)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
      onClick={(event) => {
        event.preventDefault();
        if (!routing || isOpening) return;
        setIsOpening(true);
        void routing.activateConversation(featureId).finally(() => setIsOpening(false));
      }}
    >
      {children}
      {isOpening && (
        <Loader2Icon
          className="ml-1 inline size-3 animate-spin"
          aria-label="Opening conversation"
        />
      )}
    </a>
  );
}

function FileReferenceLink({
  reference,
  openInEditor,
  children,
}: {
  reference: { path: string; line?: number; col?: number };
  openInEditor: ReturnType<typeof useOpenDiffInEditor>;
  children: React.ReactNode;
}): ReactElement {
  return (
    <a
      href="#"
      className="rounded-sm font-semibold text-[var(--acc-cyan)] underline decoration-[var(--acc-cyan)]/50 underline-offset-2 hover:bg-[var(--acc-cyan)]/10"
      onClick={(event) => {
        event.preventDefault();
        openInEditor?.(reference.path, reference.line, reference.col);
      }}
    >
      {children}
    </a>
  );
}

// Mermaid is heavy (~500KB) and pulled in only when a diagram is rendered.
const MermaidDiagram = lazy(() => import("@/components/MermaidDiagram"));

// `common` ships ~35 grammars vs. `all`'s ~155; unregistered languages fall
// back to plain text via `cachedHighlight`'s catch.
const lowlight = createLowlight(common);
// TOML uses highlight.js's `ini` grammar.
lowlight.register("toml", ini);

/** Cache for syntax-highlighted JSX to avoid re-highlighting identical code blocks. */
const highlightCache = new Map<string, React.ReactNode>();
const HIGHLIGHT_CACHE_MAX = 200;

/**
 * Cache for the rendered markdown element, keyed on the markdown
 * content plus the presence of a `sendToTerminal` action (which changes the
 * components mapping). Stable entries are reused across mounts so that
 * scrolling a long conversation through Virtuoso preserves element
 * identity, letting downstream `React.memo`'d trees bail out on repeat
 * renders.
 *
 * The cache is opt-in via the `cacheKey` prop on `Markdown`: callers set it
 * for stable blocks (e.g. older messages) and leave it `undefined` for the
 * actively streaming block so partial states do not pollute the cache.
 */
const markdownTreeCache = new Map<string, ReactElement>();
const MARKDOWN_CACHE_MAX = 200;

function evictOldestMarkdownEntry(): void {
  const firstKey = markdownTreeCache.keys().next().value;
  if (firstKey !== undefined) markdownTreeCache.delete(firstKey);
}

/** Test helpers — not exported from the package barrel. */
export const __markdownCacheTestHelpers = {
  size: (): number => markdownTreeCache.size,
  clear: (): void => {
    markdownTreeCache.clear();
  },
  has: (content: string, sendToTerminal: boolean): boolean =>
    markdownTreeCache.has(`${sendToTerminal ? "1" : "0"}\0${content}`),
};

export function cachedHighlight(lang: string, code: string): React.ReactNode {
  const key = `${lang}\0${code}`;
  const cached = highlightCache.get(key);
  if (cached !== undefined) return cached;
  try {
    const tree = lowlight.highlight(lang, code);
    const result = toJsxRuntime(tree, { Fragment, jsx, jsxs });
    if (highlightCache.size >= HIGHLIGHT_CACHE_MAX) {
      // Evict oldest entry
      const firstKey = highlightCache.keys().next().value;
      if (firstKey !== undefined) highlightCache.delete(firstKey);
    }
    highlightCache.set(key, result);
    return result;
  } catch {
    return null;
  }
}

/** Extract plain text from React children (handles nested elements from the renderer). */
function extractText(children: React.ReactNode): string {
  if (typeof children === "string") return children;
  if (typeof children === "number") return String(children);
  if (Array.isArray(children)) return children.map(extractText).join("");
  if (children && typeof children === "object" && "props" in children) {
    const el = children as React.ReactElement<{ children?: React.ReactNode }>;
    return extractText(el.props.children);
  }
  return "";
}

const SHELL_LANGUAGES = new Set(["bash", "sh", "zsh", "shell", "console", "terminal"]);

/**
 * Whether a fenced code block has received its closing ``` fence. While an
 * agent streams, remark parses the still-open fence as a code block that runs
 * to the end of the content, so its last line is diagram source rather than a
 * fence marker. We use this to hold off rendering a mermaid diagram until the
 * block is fully emitted — partial source would otherwise thrash the parser.
 */
function isFenceClosed(
  content: string,
  node?: { position?: { end?: { line?: number } } },
): boolean {
  const endLine = node?.position?.end?.line;
  if (endLine == null) return true; // no position info → treat as complete
  const lastLine = content.split("\n")[endLine - 1];
  return lastLine !== undefined && /^\s{0,3}(```|~~~)/.test(lastLine);
}

/** Shown while the lazy mermaid chunk loads. */
function MermaidFallback({ code }: { code: string }): ReactElement {
  return (
    <CodeBlockShell language="mermaid" code={code}>
      <div className="p-3 text-xs text-muted-foreground">Loading diagram…</div>
    </CodeBlockShell>
  );
}

function buildComponents(
  // A ref (not the raw string) so the components object stays stable across
  // streaming ticks; the code renderer reads the latest content at build time.
  contentRef: { readonly current: string },
  sendToTerminal?: (cmd: string) => void,
  renderDiagrams = false,
): Components {
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
    code: ({ className, children, node, ...props }) => {
      const match = /language-(\w+)/.exec(className || "");
      const isBlock = node?.position && node.position.start.line !== node.position.end.line;
      if (match || isBlock) {
        const lang = match?.[1] ?? "text";
        const code = extractText(children).replace(/\n$/, "");
        // Render mermaid as a diagram only once the closing fence has arrived;
        // until then (mid-stream) it falls through to the normal highlighted
        // code block so the user sees the source instead of a parse error.
        if (lang === "mermaid" && renderDiagrams && isFenceClosed(contentRef.current, node)) {
          return (
            <Suspense fallback={<MermaidFallback code={code} />}>
              <MermaidDiagram code={code} />
            </Suspense>
          );
        }
        const isShell = SHELL_LANGUAGES.has(lang);
        const highlighted = cachedHighlight(lang, code) ?? children;
        return (
          <CodeBlockShell
            language={lang}
            code={code}
            showTerminalButton={isShell && !!sendToTerminal}
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
    },
    pre: ({ children }) => <>{children}</>,
    a: ({ href, children }) => <MarkdownLink href={href}>{children}</MarkdownLink>,
    img: ({ src, alt, title, width, height }) => (
      <MarkdownImg src={src} alt={alt} title={title} width={width} height={height} />
    ),
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
    // Padding, not margin: `list-style-position: outside` paints the marker to
    // the left of the content box, where the stream's `overflow-x-hidden`
    // scroller clips it — `9.` fits the overhang, `10.` loses its leading digit.
    // `em` so the reserve tracks the list's own font size rather than the root,
    // which the UI font scale moves independently.
    ul: ({ children }) => <ul className="my-1 ps-[2em] list-disc space-y-0.5">{children}</ul>,
    ol: ({ children }) => <ol className="my-1 ps-[2em] list-decimal space-y-0.5">{children}</ol>,
    hr: () => <hr className="my-3 border-border" />,
    p: ({ children }) => <p className="my-1">{children}</p>,
  };
}

interface MarkdownProps {
  content: string;
  className?: string;
  /**
   * When set, the rendered markdown tree is cached at module level so repeated
   * mounts (e.g. Virtuoso recycling items as the user scrolls) skip the parse +
   * AST walk. Leave `undefined` for the actively streaming block so
   * partial-content states are not cached.
   */
  cacheKey?: string;
  /**
   * True only for the block currently receiving tokens. Drives Streamdown's
   * `mode`, which is what keeps the per-word animation spans off every other
   * block in the conversation.
   */
  isStreaming?: boolean;
}

/**
 * Reveal animation for streamed text. `fadeIn` over `blurIn` and `sep: "word"`
 * over `"char"` are both budget calls: opacity is compositor-only, while a
 * per-word `filter` is GPU work a low-end machine cannot absorb mid-stream.
 *
 * `stagger: 0` is load-bearing, not taste. Streamdown gives each word span
 * `animation-delay: <nth-new-word> * stagger` with `animation-fill-mode: both`,
 * so a word is *invisible* until its delay elapses. Which words count as "new"
 * comes from a `prevContentLength` that Streamdown sets from a render-phase side
 * effect using a consume-once getter — so StrictMode's double-invoke reads the
 * real count on the first pass and `0` on the second, and the second is the one
 * that sticks. Every word then reads as new on every re-parse: at the stock 40ms
 * that is 8s of hidden text on a 200-word message, growing with the message.
 * (One plugin instance is also shared across blocks, so two blocks re-rendering
 * in one commit mis-classify each other's words.)
 *
 * With no delay none of that is observable: nothing is held at `opacity: 0`, and
 * every span's style string stays identical across re-parses, so React leaves
 * the attribute alone and the animation cannot restart on a word already on
 * screen. Only genuinely new DOM nodes animate. `streamdown` is pinned to an
 * exact version because this rests on its internals.
 */
const STREAM_ANIMATION: AnimateOptions = {
  animation: "fadeIn",
  duration: 120,
  easing: "ease-out",
  sep: "word",
  stagger: 0,
};

function preprocessContent(raw: string): string {
  return raw.replace(/---PLAN_START---|---PLAN_END---/g, "\n---\n");
}

const markdownUrlTransform: UrlTransform = (url, key, node) =>
  parseConversationReferenceHref(url) === null && parseFileReferenceHref(url) === null
    ? defaultUrlTransform(url, key, node)
    : url;

/**
 * Sanitization schema for raw HTML embedded in markdown. Agent output (which
 * repo or web content can influence via prompt injection) and repo-sourced
 * markdown are untrusted, so we render HTML through GitHub's default schema —
 * it drops `<script>`, event handlers, and dangerous URL schemes before they
 * reach the Electron renderer. We only widen it to keep our internal
 * `cadencr-conversation:` link scheme, which the default `href` allowlist would
 * otherwise strip.
 */
const sanitizeSchema: typeof defaultSchema = {
  ...defaultSchema,
  protocols: {
    ...defaultSchema.protocols,
    href: [...(defaultSchema.protocols?.href ?? []), "cadencr-conversation", "cadencr-file"],
  },
};

/**
 * Passing `rehypePlugins` *replaces* Streamdown's defaults (`rehype-raw`,
 * `rehype-sanitize`, `rehype-harden`) rather than extending them, so the raw-HTML
 * chain has to be spelled out here. Dropping `rehype-harden` costs nothing: its
 * defaults allow every protocol and prefix, and our own sanitize schema is the
 * thing actually restricting HTML.
 *
 * Both arrays are module constants because Streamdown caches its compiled
 * processor on plugin-array identity — rebuilding them per render would defeat
 * the cache on every streaming tick.
 */
const RAW_HTML_PLUGINS: RehypePlugins = [rehypeRaw, [rehypeSanitize, sanitizeSchema]];
/** Prose has no `<`, so it skips the parse5 re-parse and the sanitize walk. */
const NO_RAW_HTML_PLUGINS: RehypePlugins = [];

/**
 * Module constant for the same reason RAW_HTML_PLUGINS is: Streamdown caches
 * its compiled processor on plugin-array identity, so a fresh array per
 * render would defeat that cache on every streaming tick. Spreading
 * `defaultRemarkPlugins` is required — passing `remarkPlugins` replaces
 * Streamdown's own defaults (GFM, etc.) rather than extending them.
 */
const REMARK_PLUGINS = [...Object.values(defaultRemarkPlugins), fileReferenceRemarkPlugin];

export const Markdown = memo(function Markdown({
  content,
  className,
  cacheKey,
  isStreaming = false,
}: MarkdownProps) {
  const { sendToTerminal } = useCodeBlockActions();
  // A set `cacheKey` marks a stable (non-streaming) block; only then do we
  // render mermaid as a diagram, so partial source never thrashes the parser.
  const renderDiagrams = cacheKey !== undefined;
  // Keep the current content reachable from the (stable) components object
  // without forcing it to rebuild on every streaming tick.
  const contentRef = useRef(content);
  contentRef.current = content;
  const components = useMemo(
    () => buildComponents(contentRef, sendToTerminal, renderDiagrams),
    [sendToTerminal, renderDiagrams],
  );

  const tree = useMemo<ReactElement>(() => {
    // Streamdown splits the markdown into blocks and memoizes each one, so a
    // streaming tick re-parses only the block still being written instead of
    // the whole message — the difference between O(tokens) and O(message²).
    // `mode="static"` on settled blocks switches the animation machinery off
    // entirely, so history never pays for the per-word spans.
    const build = (): ReactElement => (
      <Streamdown
        mode={isStreaming ? "streaming" : "static"}
        // Withholding `animated` is what keeps the per-word spans off settled
        // blocks; `mode="static"` alone only stops the animation from firing.
        animated={isStreaming ? STREAM_ANIMATION : false}
        isAnimating={isStreaming}
        rehypePlugins={content.includes("<") ? RAW_HTML_PLUGINS : NO_RAW_HTML_PLUGINS}
        remarkPlugins={REMARK_PLUGINS}
        components={components}
        urlTransform={markdownUrlTransform}
        controls={false}
        lineNumbers={false}
      >
        {preprocessContent(content)}
      </Streamdown>
    );
    // A streaming tree carries per-word animation spans and partial content, so
    // it must never reach the cache that settled blocks read from. Today callers
    // never pass both, but that invariant lives in AgentBlock, not here.
    if (cacheKey === undefined || isStreaming) return build();
    const key = `${sendToTerminal ? "1" : "0"}\0${content}`;
    const cached = markdownTreeCache.get(key);
    if (cached !== undefined) {
      // Refresh recency by re-inserting (Map preserves insertion order, so
      // the freshly-set entry becomes the newest for LRU eviction).
      markdownTreeCache.delete(key);
      markdownTreeCache.set(key, cached);
      return cached;
    }
    const fresh = build();
    if (markdownTreeCache.size >= MARKDOWN_CACHE_MAX) evictOldestMarkdownEntry();
    markdownTreeCache.set(key, fresh);
    return fresh;
  }, [cacheKey, content, components, isStreaming, sendToTerminal]);

  return <div className={cn("text-sm leading-relaxed text-foreground", className)}>{tree}</div>;
});
