/**
 * Images embedded in release notes — screenshots committed to Cadencr's
 * repository and referenced by their GitHub URL.
 *
 * The renderer runs under `img-src 'self' data: blob:`, so a remote source is
 * blocked before the request leaves. The Electron main process fetches the
 * bytes (`electron/main/changelog-images.ts`) and they render from a `blob:` URL.
 */
import type { ReactElement } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  DecodedMarkdownImage,
  isDirectSource,
  ProxiedMarkdownImage,
  type MarkdownImageProps,
} from "@/components/markdown-image";
import { useObjectUrl } from "@/hooks/useObjectUrl";
import { apiErrorMessage } from "@/lib/api-errors";
import { desktopBridge } from "@/lib/desktop-bridge";

/** Electron prefixes errors thrown by an `ipcMain.handle` handler; keep only the handler's message. */
const IPC_ERROR_PREFIX = /^Error invoking remote method '[^']+': (?:Error: )?/;

async function changelogImageBlob(src: string): Promise<Blob> {
  const { data, mimeType } = await desktopBridge.fetchChangelogImage(src);
  return new Blob([data], { type: mimeType });
}

/** `img` renderer for markdown inside the changelog dialogs. */
export function ChangelogImage(props: MarkdownImageProps): ReactElement {
  const src = props.src ?? "";
  const direct = isDirectSource(src);
  const query = useQuery({
    queryKey: ["changelog-image", src],
    queryFn: () => changelogImageBlob(src),
    enabled: src.length > 0 && !direct,
    // A release's images don't change while the dialog is open, and a missing
    // one stays missing. This is the only cache: the main process keeps none.
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
  });
  const url = useObjectUrl(query.data);

  if (direct) return <DecodedMarkdownImage key={src} {...props} />;
  const errorMessage = !src
    ? "This image has no source."
    : query.error
      ? apiErrorMessage(query.error, "Could not load this image").replace(IPC_ERROR_PREFIX, "")
      : null;
  return <ProxiedMarkdownImage {...props} url={url} errorMessage={errorMessage} />;
}
