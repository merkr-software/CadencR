import { useRef, useState, type ReactElement, type ReactNode } from "react";
import { Loader2Icon } from "lucide-react";
import { useOpenDiffInEditor } from "@/components/diff/OpenDiffInEditorContext";
import { useLinkRouting, type LinkRouting } from "@/components/links/LinkRoutingContext";
import { parseConversationReferenceHref } from "@/components/prompt-editor/conversation-reference";
import { parseFileReferenceHref } from "@/components/prompt-editor/file-reference";

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
    <ExternalLink href={href} routing={routing}>
      {children}
    </ExternalLink>
  );
}

function ExternalLink({
  href,
  routing,
  children,
}: {
  href: string;
  routing: LinkRouting;
  children: ReactNode;
}): ReactElement {
  // A click whose pointerdown happened more than a few pixels away is a
  // text-selection drag that started on the link — don't hijack it.
  const pointerDownRef = useRef<{ x: number; y: number } | null>(null);
  return (
    <a
      href={href}
      rel="noopener noreferrer"
      className={LINK_CLASS}
      onPointerDown={(event) => {
        pointerDownRef.current = { x: event.clientX, y: event.clientY };
      }}
      onClick={(event) => {
        event.preventDefault();
        const origin = pointerDownRef.current;
        pointerDownRef.current = null;
        // Keyboard clicks (Enter) carry detail 0 and no pointer coordinates —
        // never treat them as drags, even after a stale pointerdown that
        // ended without a click (e.g. press on the link, release outside).
        if (
          event.detail !== 0 &&
          origin &&
          Math.hypot(event.clientX - origin.x, event.clientY - origin.y) > 4
        )
          return;
        routing.activate(href);
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
