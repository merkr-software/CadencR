import { customInstance } from "@/api/client";

/**
 * Fetch an image an agent posted in chat by local path. The service serves it
 * only when the feature's transcript shows `src` as an image; callers turn the
 * Blob into a `blob:` object URL, the one image source the renderer CSP admits
 * over remote access as well as locally.
 *
 * `src` is passed exactly as the markdown renderer received it: the service
 * resolves relative paths against the feature's working directory.
 */
export function agentImageBlob(
  featureId: number,
  src: string,
  signal?: AbortSignal,
): Promise<Blob> {
  return customInstance<Blob>({
    url: `/api/features/${featureId}/agent-image`,
    method: "GET",
    params: { src },
    responseType: "blob",
    signal,
  });
}

/** React Query key for an agent image, so one screenshot shown twice is fetched once. */
export function agentImageBlobQueryKey(featureId: number, src: string): readonly unknown[] {
  return [`/api/features/${featureId}/agent-image`, { src }];
}
