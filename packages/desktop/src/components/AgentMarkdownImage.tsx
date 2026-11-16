/**
 * Images an agent posts in chat by local path — typically a QA screenshot,
 * `![after](/tmp/qa/after.png)`. Every local source loads through the service
 * (see `agent-image-blob.ts`), so it renders the same in the local window and
 * over remote access.
 */
import { createContext, useContext, type ReactElement, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  MarkdownImageProvider,
  PlainMarkdownImage,
  ProxiedMarkdownImage,
  type MarkdownImageProps,
} from "@/components/markdown-image";
import { useObjectUrl } from "@/hooks/useObjectUrl";
import { apiErrorCode, apiErrorMessage } from "@/lib/api-errors";
import { agentImageBlob, agentImageBlobQueryKey } from "@/lib/agent-image-blob";
import { isImageFile } from "@/lib/file-language";

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
  return isImageFile(src) || /\.svg$/i.test(src);
}

function AgentMarkdownImage(props: MarkdownImageProps): ReactElement {
  const featureId = useContext(AgentImageFeature);
  if (featureId === null || !props.src || !isLocalImageSource(props.src)) {
    return <PlainMarkdownImage {...props} />;
  }
  return <LocalAgentImage {...props} featureId={featureId} src={props.src} />;
}

function LocalAgentImage({
  featureId,
  ...props
}: MarkdownImageProps & { featureId: number; src: string }): ReactElement {
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
    ? apiErrorMessage(query.error, "Could not load this image")
    : null;
  return <ProxiedMarkdownImage {...props} url={url} errorMessage={errorMessage} />;
}
