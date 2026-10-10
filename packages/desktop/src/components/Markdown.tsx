import { memo, useMemo, useRef, type ReactElement } from "react";
import {
  Streamdown,
  defaultUrlTransform,
  type AnimateOptions,
  type StreamdownProps,
  type UrlTransform,
} from "streamdown";
import "streamdown/styles.css";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import { cn } from "@/lib/utils";
import { useCodeBlockActions } from "@/components/CodeBlockActionsContext";
import { parseConversationReferenceHref } from "@/components/prompt-editor/conversation-reference";
import { parseFileReferenceHref } from "@/components/prompt-editor/file-reference";
import { fileReferenceRemarkPlugin } from "@/components/prompt-editor/file-reference-remark-plugin";
import { defaultRemarkPlugins } from "streamdown";
import {
  AGENT_FILE_HREF_SCHEME,
  protectAgentFileHrefs,
  restoreAgentFileHrefs,
} from "@/components/markdown/agent-file-href-sanitize";
import { buildMarkdownComponents } from "@/components/markdown/markdown-components";
import { markdownTreeCache } from "@/components/markdown/markdown-tree-cache";
import "./dracula-highlight.css";

export { highlightCode as cachedHighlight } from "@/components/markdown/highlight-cache";

type RehypePlugins = NonNullable<StreamdownProps["rehypePlugins"]>;

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
  /** Render settled content without retaining its potentially large trees globally. */
  disableCache?: boolean;
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
 * otherwise strip, plus the envelope agent file links cross it in (see
 * `agent-file-href-sanitize.ts`).
 */
const sanitizeSchema: typeof defaultSchema = {
  ...defaultSchema,
  protocols: {
    ...defaultSchema.protocols,
    href: [
      ...(defaultSchema.protocols?.href ?? []),
      "cadencr-conversation",
      "cadencr-file",
      AGENT_FILE_HREF_SCHEME,
    ],
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
const RAW_HTML_PLUGINS: RehypePlugins = [
  rehypeRaw,
  protectAgentFileHrefs,
  [rehypeSanitize, sanitizeSchema],
  restoreAgentFileHrefs,
];
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
  disableCache = false,
}: MarkdownProps) {
  const { sendToTerminal } = useCodeBlockActions();
  // Both signals are required: callers opt stable blocks into caching with
  // `cacheKey`, while `isStreaming` fail-closes an accidentally keyed live block.
  const isSettled = cacheKey !== undefined && !isStreaming;
  const shouldCache = isSettled && !disableCache;
  // Streaming renderers read a mutable ref so their identity survives each token.
  // Settled renderers instead capture immutable content: a cached tree must not
  // observe this component instance later switching to a different block.
  const streamingContentRef = useRef(content);
  streamingContentRef.current = content;
  const settledContent = isSettled ? content : "";
  const components = useMemo(
    () =>
      isSettled
        ? buildMarkdownComponents({
            contentRef: { current: settledContent },
            sendToTerminal,
            isSettled: true,
            isStreaming: false,
            cacheHighlights: !disableCache,
          })
        : buildMarkdownComponents({
            contentRef: streamingContentRef,
            sendToTerminal,
            isSettled: false,
            isStreaming,
          }),
    [disableCache, isSettled, isStreaming, settledContent, sendToTerminal],
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
    if (!shouldCache || cacheKey === undefined) return build();
    return markdownTreeCache.getOrCreate({ cacheKey, content, sendToTerminal }, build);
  }, [cacheKey, content, components, isStreaming, sendToTerminal, shouldCache]);

  return <div className={cn("text-sm leading-relaxed text-foreground", className)}>{tree}</div>;
});
