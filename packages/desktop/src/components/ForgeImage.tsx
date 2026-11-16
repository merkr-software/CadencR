/**
 * Images that belong to a pull request: the authors' faces, and whatever a
 * reviewer pasted into a comment.
 *
 * None of them can be an ordinary `<img src="https://…">`. The renderer runs
 * under `img-src 'self' data: blob:`, so a remote source is blocked before the
 * request leaves, and a private repository's attachments need the forge token
 * on the way out. Both are answered the same way the editor answers local
 * images: the service fetches the bytes, and these render them from a `blob:`
 * URL.
 *
 * Scope this with {@link ForgeImageScope}; without it every image falls back to
 * the plain `<img>` it would have been.
 */
import {
  createContext,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { useQuery } from "@tanstack/react-query";
import { ImageIcon } from "lucide-react";
import type { ForgeUser } from "@/api/generated";
import {
  isDirectSource,
  MARKDOWN_IMAGE_NOTICE_CLASS,
  MarkdownImageNotice,
  MarkdownImageProvider,
  PlainMarkdownImage,
  ProxiedMarkdownImage,
  type MarkdownImageProps,
} from "@/components/markdown-image";
import { useObjectUrl } from "@/hooks/useObjectUrl";
import { useInViewport } from "@/hooks/useInViewport";
import { apiErrorMessage } from "@/lib/api-errors";
import {
  forgeImageBlob,
  forgeImageBlobQueryKey,
  type ForgeImageKind,
} from "@/lib/forge-image-blob";
import { cn } from "@/lib/utils";

const MAX_AUTOMATIC_CONTENT_IMAGES = 4;
const MAX_AUTOMATIC_AVATARS = 24;

/** Which feature's forge (and therefore whose credentials) serves these images. */
interface ForgeImageScopeState {
  automaticAvatars: Set<string>;
  automaticContent: Set<string>;
  featureId: number;
}

const ForgeImageFeature = createContext<ForgeImageScopeState | null>(null);

/**
 * Marks a subtree as belonging to one pull request, so everything inside it —
 * markdown bodies included — loads its images through that feature's forge.
 */
export function ForgeImageScope({
  featureId,
  children,
}: {
  featureId: number;
  children: ReactNode;
}): ReactElement {
  const scope = useMemo<ForgeImageScopeState>(
    () => ({
      automaticAvatars: new Set(),
      automaticContent: new Set(),
      featureId,
    }),
    [featureId],
  );
  return (
    <ForgeImageFeature.Provider value={scope}>
      <MarkdownImageProvider value={ForgeMarkdownImage}>{children}</MarkdownImageProvider>
    </ForgeImageFeature.Provider>
  );
}

interface ForgeImageState {
  url: string | null;
  errorMessage: string | null;
  /** The source is already renderable as-is — the CSP allows it unproxied. */
  direct: boolean;
  /** A feature's forge is in scope, so a proxied fetch is possible at all. */
  scoped: boolean;
}

function useForgeImage(
  src: string | undefined,
  kind: ForgeImageKind,
  enabled: boolean,
): ForgeImageState {
  const scope = useContext(ForgeImageFeature);
  const direct = !src || isDirectSource(src);
  const scoped = scope !== null;
  const query = useQuery({
    queryKey: forgeImageBlobQueryKey(scope?.featureId ?? 0, src ?? "", kind),
    queryFn: ({ signal }) => forgeImageBlob(scope?.featureId ?? 0, src ?? "", kind, signal),
    enabled: scoped && !direct && enabled,
    // Near-viewport instances share one request, but the bytes leave the query
    // cache as soon as the last visible instance unmounts. A malicious PR must
    // not pin an unbounded gallery of blobs for minutes after scrolling past it.
    staleTime: 5 * 60_000,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    // A forge that refused this image once will refuse it again; a retry storm
    // across every avatar in a long review is the expensive way to find out.
    retry: false,
  });
  const url = useObjectUrl(query.data);
  return {
    url,
    errorMessage: query.error ? apiErrorMessage(query.error, "Could not load this image") : null,
    direct,
    scoped,
  };
}

function claimAutomaticImage(
  scope: ForgeImageScopeState,
  src: string,
  kind: ForgeImageKind,
): boolean {
  const bucket = kind === "avatar" ? scope.automaticAvatars : scope.automaticContent;
  const limit = kind === "avatar" ? MAX_AUTOMATIC_AVATARS : MAX_AUTOMATIC_CONTENT_IMAGES;
  if (bucket.has(src)) return true;
  if (bucket.size >= limit) return false;
  bucket.add(src);
  return true;
}

/**
 * `img` renderer for markdown inside a pull request.
 *
 * Failures are named rather than left as a broken-image glyph: an attachment on
 * a repository the token cannot read is a fixable problem, and the chip carries
 * the reason in its tooltip.
 */
export function ForgeMarkdownImage(props: MarkdownImageProps): ReactElement {
  const scope = useContext(ForgeImageFeature);
  if (!props.src || isDirectSource(props.src) || !scope) {
    return <PlainMarkdownImage {...props} />;
  }
  return <DeferredForgeMarkdownImage key={props.src} scope={scope} {...props} />;
}

function DeferredForgeMarkdownImage({
  scope,
  ...props
}: MarkdownImageProps & { scope: ForgeImageScopeState }): ReactElement {
  const viewportRootRef = useRef<HTMLElement | null>(null);
  const { setRef, inView } = useInViewport(viewportRootRef, "300px 0px");
  const [manualLoad, setManualLoad] = useState(false);
  const [automaticLoad] = useState(() => claimAutomaticImage(scope, props.src ?? "", "content"));
  const label = props.alt || props.src || "image";
  if (!automaticLoad && !manualLoad) {
    return (
      <span ref={setRef}>
        <button
          type="button"
          onClick={() => setManualLoad(true)}
          className={cn(
            MARKDOWN_IMAGE_NOTICE_CLASS,
            "hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary",
          )}
        >
          <ImageIcon className="size-3.5 shrink-0" aria-hidden />
          <span className="truncate">Load {label}</span>
        </button>
      </span>
    );
  }
  return (
    <span ref={setRef}>
      {inView ? (
        <LoadedForgeMarkdownImage {...props} />
      ) : (
        <MarkdownImageNotice label={label}>
          <ImageIcon className="size-3.5 shrink-0" aria-hidden />
        </MarkdownImageNotice>
      )}
    </span>
  );
}

function LoadedForgeMarkdownImage(props: MarkdownImageProps): ReactElement {
  const { url, errorMessage } = useForgeImage(props.src, "content", true);
  return <ProxiedMarkdownImage {...props} url={url} errorMessage={errorMessage} />;
}

/**
 * A comment author's face, with their initials underneath it.
 *
 * The initials are not a fallback bolted on afterwards: they render first and
 * stay put until the bytes arrive, so a thread never reflows as avatars land,
 * and a forge that will not part with the picture still names everyone. An
 * outright failure keeps the initials and explains itself on hover.
 */
export function ForgeAvatar({
  user,
  className,
}: {
  user: ForgeUser;
  className?: string;
}): ReactElement {
  const name = user.display_name ?? user.username;
  const scope = useContext(ForgeImageFeature);
  const viewportRootRef = useRef<HTMLElement | null>(null);
  const { setRef, inView } = useInViewport(viewportRootRef, "300px 0px");
  const [automaticLoad] = useState(() =>
    scope && user.avatar_url ? claimAutomaticImage(scope, user.avatar_url, "avatar") : false,
  );
  return (
    <span
      ref={setRef}
      className={cn(
        "relative grid size-5 shrink-0 place-items-center overflow-hidden rounded-full bg-muted text-[10px] font-semibold text-foreground",
        className,
      )}
    >
      {authorInitials(name)}
      {inView && automaticLoad && user.avatar_url && <ForgeAvatarImage src={user.avatar_url} />}
    </span>
  );
}

function ForgeAvatarImage({ src }: { src: string }): ReactElement | null {
  const { url, errorMessage } = useForgeImage(src, "avatar", true);
  return (
    <span title={errorMessage ?? undefined} className="pointer-events-none absolute inset-0">
      {url && <img src={url} alt="" aria-hidden className="size-full object-cover" />}
    </span>
  );
}

/** First letters of the first two words — "?" when there is nothing to letter. */
function authorInitials(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join("") || "?"
  );
}
