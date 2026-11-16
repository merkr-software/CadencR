import {
  createContext,
  useContext,
  useState,
  type ComponentType,
  type ReactElement,
  type ReactEventHandler,
  type ReactNode,
} from "react";
import { ImageOffIcon, Loader2Icon } from "lucide-react";

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
}: MarkdownImageProps & { onError?: ReactEventHandler<HTMLImageElement> }): ReactElement {
  return (
    <img
      src={src}
      alt={alt ?? ""}
      title={title}
      width={width}
      height={height}
      onError={onError}
      loading="lazy"
      className="inline-block h-auto max-w-full rounded align-middle"
    />
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
  ...props
}: MarkdownImageProps & { url: string | null; errorMessage: string | null }): ReactElement {
  const label = props.alt || props.src || "image";
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
  return <DecodedMarkdownImage key={url} {...props} src={url} />;
}

/** Fetching bytes can succeed even when the browser cannot decode them. */
export function DecodedMarkdownImage(props: MarkdownImageProps): ReactElement {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <MarkdownImageNotice title="Could not display this image." label={props.alt || "image"}>
        <ImageOffIcon className="size-3.5 shrink-0" aria-hidden />
      </MarkdownImageNotice>
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
  const Renderer = useContext(MarkdownImageContext);
  if (props.src === INCOMPLETE_MARKDOWN_IMAGE_SRC) {
    return (
      <MarkdownImageNotice label={props.alt || "image"}>
        <Loader2Icon className="size-3.5 shrink-0 animate-spin" aria-label="Loading image" />
      </MarkdownImageNotice>
    );
  }
  return Renderer ? <Renderer {...props} /> : <PlainMarkdownImage {...props} />;
}
