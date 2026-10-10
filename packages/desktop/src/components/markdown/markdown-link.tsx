import { useState, type ReactElement, type ReactNode } from "react";
import { ArrowUpRightIcon, Loader2Icon } from "lucide-react";
import { useOpenDiffInEditor } from "@/components/diff/OpenDiffInEditorContext";
import { useLinkRouting, type LinkRouting } from "@/components/links/LinkRoutingContext";
import { parseConversationReferenceHref } from "@/components/prompt-editor/conversation-reference";
import {
  parseAgentFileHref,
  parseFileReferenceHref,
} from "@/components/prompt-editor/file-reference";
import { isUserOpenableUrl } from "@/lib/safe-url";

const LINK_CLASS =
  "text-[var(--acc-cyan)] underline underline-offset-2 hover:text-[var(--acc-purple)]";

/** Routes Markdown links through feature-aware file and conversation actions. */
export function MarkdownLink({
  href,
  children,
}: {
  href?: string;
  children: ReactNode;
}): ReactElement {
  const routing = useLinkRouting();
  const openInEditor = useOpenDiffInEditor();
  // `@file` mentions carry their own scheme; agents write plain path links.
  // Those only become file links where an Editor can open them.
  const fileReference = href
    ? (parseFileReferenceHref(href) ?? (openInEditor ? parseAgentFileHref(href) : null))
    : null;
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
  if (!href) {
    return <a className={LINK_CLASS}>{children}</a>;
  }
  // Markdown labels hide the URL (`[docs](https://…)`): name the destination
  // on hover and mark links that leave the conversation. A native `title`
  // keeps each link a bare <a> — a tooltip primitive per link is real cost in
  // a long, streaming transcript.
  const isWeb = isUserOpenableUrl(href);
  const title = isWeb ? href : undefined;
  const externalMark = isWeb ? (
    <ArrowUpRightIcon
      aria-hidden
      className="ml-px inline size-[0.85em] align-[-0.05em] opacity-70"
    />
  ) : null;
  if (!routing) {
    return (
      <a href={href} title={title} target="_blank" rel="noopener noreferrer" className={LINK_CLASS}>
        {children}
        {externalMark}
      </a>
    );
  }
  return (
    <a
      href={href}
      title={title}
      rel="noopener noreferrer"
      className={LINK_CLASS}
      onClick={(event) => {
        // Never the default: it would navigate the app window itself. Web
        // links open on a plain click or tap; anything else (mailto:, paths,
        // fragments) keeps needing Cmd/Ctrl, since the router may refuse it.
        event.preventDefault();
        if (isSelectingLinkText(event.currentTarget)) return;
        if (isWeb || event.metaKey || event.ctrlKey) routing.activate(href);
      }}
      onMouseEnter={() => routing.setHoverLink(href)}
      onMouseLeave={() => routing.setHoverLink(null)}
    >
      {children}
      {externalMark}
    </a>
  );
}

/**
 * Dragging across link text to select it finishes with a click on the link;
 * opening it then would throw the selection away.
 */
function isSelectingLinkText(link: HTMLElement): boolean {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed) return false;
  for (let i = 0; i < selection.rangeCount; i++) {
    if (selection.getRangeAt(i).intersectsNode(link)) return true;
  }
  return false;
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
  children: ReactNode;
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
  children: ReactNode;
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
