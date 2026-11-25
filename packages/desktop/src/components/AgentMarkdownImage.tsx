import { useUiTranslation } from "@/lib/i18n/ui";
/**
 * Images an agent posts in chat by local path — typically a QA screenshot,
 * `![after](/tmp/qa/after.png)`. Every local source loads through the service
 * (see `agent-image-blob.ts`), so it renders the same in the local window and
 * over remote access.
 */
import {
  createContext,
  useCallback,
  useContext,
  useId,
  type ReactElement,
  type ReactNode,
} from "react";
import { useQuery } from "@tanstack/react-query";
import {
  DecodedMarkdownImage,
  isDirectSource,
  MarkdownImageProvider,
  PlainMarkdownImage,
  ProxiedMarkdownImage,
  type MarkdownImageProps,
} from "@/components/markdown-image";
import { useInsideMarkdownLink } from "@/components/markdown/markdown-link";
import { useObjectUrl } from "@/hooks/useObjectUrl";
import { apiErrorCode, apiErrorMessage } from "@/lib/api-errors";
import { agentImageBlob, agentImageBlobQueryKey } from "@/lib/agent-image-blob";
import { getFileName, isImageFile, isSvgFile } from "@/lib/file-language";
import { openImageLightbox } from "@/stores/image-lightbox-store";

const AgentImageFeature = createContext<number | null>(null);

/** Marks a subtree as one feature's conversation, whose local images it can load. */
export function AgentImageScope({
  featureId,
  children,
}: {
  featureId: number | undefined;
  children: ReactNode;
}): ReactElement {
  if (featureId === undefined) return <>{children}</>;
  return (
    <AgentImageFeature.Provider value={featureId}>
      <MarkdownImageProvider value={AgentMarkdownImage}>{children}</MarkdownImageProvider>
    </AgentImageFeature.Provider>
  );
}

/**
 * Whether `src` names an image file on the host: a path or a `file:` URL with
 * an extension the service serves. Web and protocol-relative URLs are not.
 */
export function isLocalImageSource(src: string): boolean {
  if (src.startsWith("//")) return false;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(src)?.[1];
  if (scheme !== undefined && scheme.toLowerCase() !== "file") return false;
  return isImageFile(src) || isSvgFile(src);
}

function imageFileName(src: string): string | undefined {
  const clean = src.split(/[?#]/)[0];
  const segment = getFileName(clean);
  if (!segment) return undefined;
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function dataUrlMediaType(src: string): string | undefined {
  return /^data:([^;,]+)/i.exec(src)?.[1];
}

function AgentMarkdownImage(props: MarkdownImageProps): ReactElement {
  const featureId = useContext(AgentImageFeature);
  const insideLink = useInsideMarkdownLink();
  if (featureId !== null && props.src && isLocalImageSource(props.src)) {
    return (
      <LocalAgentImage {...props} featureId={featureId} src={props.src} insideLink={insideLink} />
    );
  }
  if (!insideLink && props.src && isDirectSource(props.src)) {
    return <DirectAgentImage {...props} src={props.src} />;
  }
  return <PlainMarkdownImage {...props} />;
}

function DirectAgentImage(props: MarkdownImageProps & { src: string }): ReactElement {
  const id = useId();
  const onExpand = useCallback(() => {
    openImageLightbox(
      [
        {
          id: `agent-direct-image:${id}`,
          src: props.src,
          alt: props.alt || "image",
          mediaType: dataUrlMediaType(props.src),
        },
      ],
      0,
    );
  }, [id, props.alt, props.src]);
  return <DecodedMarkdownImage key={props.src} {...props} onExpand={onExpand} />;
}

function LocalAgentImage({
  featureId,
  insideLink,
  ...props
}: MarkdownImageProps & {
  featureId: number;
  src: string;
  insideLink: boolean;
}): ReactElement {
  const { t } = useUiTranslation();
  const query = useQuery({
    queryKey: agentImageBlobQueryKey(featureId, props.src),
    queryFn: ({ signal }) => agentImageBlob(featureId, props.src, signal),
    // Keeps scroll-back in the virtualized stream cheap without pinning every
    // screenshot of a long QA run (up to 25 MB each) for minutes.
    staleTime: 5 * 60_000,
    gcTime: 60_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    // A missing file stays missing, even when its row remounts. Only "not
    // referenced" earns one retry: the image can render a beat before the
    // message that shows it is persisted.
    retryOnMount: false,
    retry: (failureCount, error) =>
      failureCount < 1 && apiErrorCode(error) === "IMAGE_NOT_REFERENCED",
    retryDelay: 500,
  });
  const url = useObjectUrl(query.data);
  const errorMessage = query.error
    ? apiErrorMessage(
        query.error,
        t(
          "conversation.stream.agentMarkdownImage.couldNotLoadThisImage",
          "Could not load this image",
        ),
      )
    : null;
  const onExpand = useCallback(() => {
    const blob = query.data;
    if (!blob) return;
    const fileName = imageFileName(props.src);
    openImageLightbox(
      [
        {
          id: `agent-image:${featureId}:${props.src}`,
          src: null,
          blob,
          alt: props.alt || fileName || "image",
          fileName,
          mediaType: blob.type || undefined,
        },
      ],
      0,
    );
  }, [featureId, props.alt, props.src, query.data]);

  return (
    <ProxiedMarkdownImage
      {...props}
      url={url}
      errorMessage={errorMessage}
      onExpand={insideLink ? undefined : onExpand}
    />
  );
}
