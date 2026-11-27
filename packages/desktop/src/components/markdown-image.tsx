import { useUiTranslation } from "@/lib/i18n/ui";
import {
  createContext,
  useContext,
  useState,
  type ComponentType,
  type ReactElement,
  type ReactEventHandler,
  type ReactNode,
} from "react";
import { ImageOffIcon, Loader2Icon, Maximize2Icon } from "lucide-react";

/** Internal Streamdown marker: render a loader, never fetch it as an image. */
export const INCOMPLETE_MARKDOWN_IMAGE_SRC = "streamdown:incomplete-image";

export interface MarkdownImageProps {
  src?: string;
  alt?: string;
  title?: string;
  width?: string | number;
  height?: string | number;
}

/**
 * Component the Markdown renderer delegates `<img>` rendering to. Provided
 * where images need fetching outside the renderer's CSP (the editor preview
 * resolves repo-relative paths to files; agent chat loads the local paths an
 * agent posts; pull requests and the changelog proxy remote images); left null
 * elsewhere, where images are rendered as a plain `<img>`.
 */
export type MarkdownImageRenderer = ComponentType<MarkdownImageProps>;

const MarkdownImageContext = createContext<MarkdownImageRenderer | null>(null);
export const MarkdownImageProvider = MarkdownImageContext.Provider;

/** `data:` and `blob:` sources are what the CSP already permits. */
export function isDirectSource(src: string): boolean {
  return src.startsWith("data:") || src.startsWith("blob:");
}

/**
 * A plain, overflow-safe `<img>` — the shared presentation for markdown images.
 * Inline and middle-aligned: badges share a text line with headings and prose.
 */
export function PlainMarkdownImage({
  src,
  alt,
  title,
  width,
  height,
  onError,
  onLoad,
}: MarkdownImageProps & {
  onError?: ReactEventHandler<HTMLImageElement>;
  onLoad?: ReactEventHandler<HTMLImageElement>;
}): ReactElement {
  return (
    <img
      src={src}
      alt={alt ?? ""}
      title={title}
      width={width}
      height={height}
      onError={onError}
      onLoad={onLoad}
      loading="lazy"
      className="inline-block h-auto max-w-full rounded align-middle"
    />
  );
}

/**
 * Clickable markdown image that opens full screen when clicking anywhere on
 * the image or its floating top-right button. Rendered as an inline-block
 * `<button>` so it remains valid phrasing content inside `<p>`.
 */
function ExpandableMarkdownImage({
  onExpand,
  onError,
  ...props
}: MarkdownImageProps & {
  onExpand: () => void;
  onError?: ReactEventHandler<HTMLImageElement>;
}): ReactElement {
  const { t } = useUiTranslation();
  const [isTiny, setIsTiny] = useState(false);
  const handleLoad: ReactEventHandler<HTMLImageElement> = (event) => {
    const { naturalWidth, naturalHeight } = event.currentTarget;
    setIsTiny(naturalWidth > 0 && naturalHeight > 0 && Math.min(naturalWidth, naturalHeight) < 48);
  };
  const label = props.alt
    ? t("conversation.stream.markdownImage.fullScreen", "Full screen: {{image}}", {
        image: props.alt,
      })
    : t("conversation.stream.markdownImage.fullScreenLabel", "Full screen");
  return (
    <button
      type="button"
      onClick={onExpand}
      title={props.title ?? t("conversation.stream.markdownImage.fullScreenLabel", "Full screen")}
      aria-label={label}
      className="group/mdimg relative inline-block max-w-full cursor-zoom-in rounded align-middle text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <PlainMarkdownImage {...props} onError={onError} onLoad={handleLoad} />
      {!isTiny && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute right-2 top-2 z-10 flex size-6 items-center justify-center rounded-md border border-border bg-background/80 text-foreground opacity-0 backdrop-blur-sm transition-opacity group-hover/mdimg:opacity-100 group-focus-visible/mdimg:opacity-100"
        >
          <Maximize2Icon className="size-3.5" />
        </span>
      )}
    </button>
  );
}

/** The inline chip's shell, shared with the forge's "Load image" button. */
export const MARKDOWN_IMAGE_NOTICE_CLASS =
  "inline-flex max-w-full items-center gap-1.5 rounded border border-border bg-muted px-2 py-1 align-middle text-xs text-muted-foreground";

/**
 * Inline chip standing in for a proxied image that is loading, deferred, or
 * failed — the icon says which, and `title` carries a failure's reason.
 */
export function MarkdownImageNotice({
  children,
  label,
  title,
}: {
  children: ReactNode;
  label: string;
  title?: string;
}): ReactElement {
  return (
    <span title={title} className={MARKDOWN_IMAGE_NOTICE_CLASS}>
      {children}
      <span className="truncate">{label}</span>
    </span>
  );
}

/**
 * A markdown image whose bytes came through a proxy: a chip while `url` is
 * pending, a chip carrying `errorMessage` once the fetch failed, else the image.
 */
export function ProxiedMarkdownImage({
  url,
  errorMessage,
  onExpand,
  ...props
}: MarkdownImageProps & {
  url: string | null;
  errorMessage: string | null;
  onExpand?: () => void;
}): ReactElement {
  const { t } = useUiTranslation();
  const label = props.alt || props.src || t("conversation.stream.markdownImage.image", "image");
  if (errorMessage) {
    return (
      <MarkdownImageNotice title={errorMessage} label={label}>
        <ImageOffIcon className="size-3.5 shrink-0" aria-hidden />
      </MarkdownImageNotice>
    );
  }
  if (!url) {
    return (
      <MarkdownImageNotice label={label}>
        <Loader2Icon className="size-3.5 shrink-0 animate-spin" aria-hidden />
      </MarkdownImageNotice>
    );
  }
  return <DecodedMarkdownImage key={url} {...props} src={url} onExpand={onExpand} />;
}

/** Fetching bytes can succeed even when the browser cannot decode them. */
export function DecodedMarkdownImage({
  onExpand,
  ...props
}: MarkdownImageProps & { onExpand?: () => void }): ReactElement {
  const { t } = useUiTranslation();
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <MarkdownImageNotice
        title={t(
          "conversation.stream.markdownImage.couldNotDisplayThisImage",
          "Could not display this image.",
        )}
        label={props.alt || t("conversation.stream.markdownImage.image", "image")}
      >
        <ImageOffIcon className="size-3.5 shrink-0" aria-hidden />
      </MarkdownImageNotice>
    );
  }
  if (onExpand) {
    return (
      <ExpandableMarkdownImage {...props} onExpand={onExpand} onError={() => setFailed(true)} />
    );
  }
  return <PlainMarkdownImage {...props} onError={() => setFailed(true)} />;
}

/**
 * `img` override for the Markdown renderer. When a context renderer is present
 * it handles the image (e.g. loading local repo files); otherwise the image is
 * rendered as a plain `<img>`.
 */
export function MarkdownImg(props: MarkdownImageProps): ReactElement {
  const { t } = useUiTranslation();
  const Renderer = useContext(MarkdownImageContext);
  if (props.src === INCOMPLETE_MARKDOWN_IMAGE_SRC) {
    return (
      <MarkdownImageNotice
        label={props.alt || t("conversation.stream.markdownImage.image", "image")}
      >
        <Loader2Icon
          className="size-3.5 shrink-0 animate-spin"
          aria-label={t("conversation.stream.markdownImage.loadingImage", "Loading image")}
        />
      </MarkdownImageNotice>
    );
  }
  return Renderer ? <Renderer {...props} /> : <PlainMarkdownImage {...props} />;
}
