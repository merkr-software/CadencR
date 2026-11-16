import { memo, useCallback, useMemo, type ReactElement, type ReactNode } from "react";
import {
  ClipboardPaste,
  FileText,
  GitPullRequest,
  MessageSquareCode,
  SquareTerminal,
  TextSelect,
  X,
} from "lucide-react";
import { LightboxThumbnail } from "@/components/image-lightbox/LightboxThumbnail";
import type { ImageAttachment } from "@/hooks/useImageAttachments";
import { openImageLightbox, type LightboxImage } from "@/stores/image-lightbox-store";
import {
  composerKeyFor,
  useComposerContextItems,
  useComposerContextStore,
  type ComposerContextItem,
  type ComposerContextKind,
} from "@/stores/composer-context-store";
import { useComposerContext } from "./ComposerContext";
import { PullRequestLinkSuggestion } from "./PullRequestLinkSuggestion";
import { ReviewCommentsSuggestion } from "./ReviewCommentsSuggestion";

const KIND_ICON: Record<ComposerContextKind, typeof FileText> = {
  pasted: ClipboardPaste,
  selection: TextSelect,
  terminal: SquareTerminal,
  pull_request: GitPullRequest,
  review: MessageSquareCode,
};

/**
 * Everything the next prompt will carry beyond its text, as removable chips
 * at the top of the composer card: images and files (named), long pastes, an
 * editor selection, terminal output, a pull request, review comments. What
 * the agent will receive is visible before Send — never implicit.
 */
export const ContextTray = memo(function ContextTray(): ReactElement | null {
  const { featureId, attachments } = useComposerContext();
  const key = composerKeyFor(featureId);
  const items = useComposerContextItems(key);
  const remove = useCallback(
    (id: string) => useComposerContextStore.getState().remove(key, id),
    [key],
  );
  const suggestions = (
    <>
      <ReviewCommentsSuggestion />
      <PullRequestLinkSuggestion />
    </>
  );
  const hasContent = attachments.items.length > 0 || items.length > 0;
  return (
    <div
      data-context-tray
      aria-label="Context sent with this message"
      className="flex flex-wrap items-center gap-1.5 px-3 pt-2.5 empty:hidden"
    >
      {hasContent && <AttachmentChips items={attachments.items} onRemove={attachments.remove} />}
      {items.map((item) => (
        <ContextChip key={item.id} item={item} onRemove={remove} />
      ))}
      {suggestions}
    </div>
  );
});

function ContextChip({
  item,
  onRemove,
}: {
  item: ComposerContextItem;
  onRemove: (id: string) => void;
}): ReactElement {
  const Icon = KIND_ICON[item.kind];
  return (
    <Chip
      icon={<Icon className="size-3.5 shrink-0 text-muted-foreground" />}
      label={item.label}
      detail={item.detail}
      title={item.content.length > 400 ? `${item.content.slice(0, 400)}…` : item.content}
      onRemove={() => onRemove(item.id)}
    />
  );
}

/** Image and file attachments as chips; an image opens in the lightbox. */
export function AttachmentChips({
  items,
  onRemove,
}: {
  items: ImageAttachment[];
  onRemove: (id: string) => void;
}): ReactElement {
  const viewable = useMemo(
    () =>
      items
        .filter((attachment) => attachment.kind === "image" && attachment.previewUrl)
        .map((attachment): LightboxImage => ({
          id: attachment.id,
          src: attachment.previewUrl,
          alt: attachment.fileName,
          fileName: attachment.fileName,
          mediaType: attachment.mimeType,
        })),
    [items],
  );
  return (
    <>
      {items.map((attachment) => {
        const index = viewable.findIndex((image) => image.id === attachment.id);
        const icon =
          index >= 0 ? (
            <LightboxThumbnail
              src={attachment.previewUrl}
              alt={attachment.fileName}
              onOpen={() => openImageLightbox(viewable, index)}
              className="size-5 shrink-0 overflow-hidden rounded-[4px]"
              imageClassName="size-full object-cover"
            />
          ) : (
            <FileText className="size-3.5 shrink-0 text-muted-foreground" />
          );
        return (
          <Chip
            key={attachment.id}
            icon={icon}
            label={attachment.fileName}
            onRemove={() => onRemove(attachment.id)}
          />
        );
      })}
    </>
  );
}

export function Chip({
  icon,
  label,
  detail,
  title,
  onRemove,
  children,
}: {
  icon: ReactNode;
  label: string;
  detail?: string;
  title?: string;
  onRemove?: () => void;
  children?: ReactNode;
}): ReactElement {
  return (
    <span
      title={title}
      className="group/chip inline-flex h-7 max-w-[280px] items-center gap-1.5 rounded-md border border-border/70 bg-muted/40 pr-1 pl-1.5 text-[12px]"
    >
      {icon}
      <span className="min-w-0 truncate font-medium text-foreground/90">{label}</span>
      {detail && <span className="shrink-0 text-muted-foreground">{detail}</span>}
      {children}
      {onRemove && (
        <button
          type="button"
          aria-label={`Remove ${label}`}
          onClick={(event) => {
            event.stopPropagation();
            onRemove();
          }}
          className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <X className="size-3" />
        </button>
      )}
    </span>
  );
}
