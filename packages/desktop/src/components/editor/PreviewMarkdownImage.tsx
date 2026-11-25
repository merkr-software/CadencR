import { useUiTranslation } from "@/lib/i18n/ui";
/**
 * Local-image renderer for the editor's Markdown preview. Repo-relative image
 * paths in a README (`<img src="docs/logo.png">` or `![](./logo.png)`) can't be
 * loaded by URL — the renderer CSP forbids the API origin and there is no
 * file:// access. Instead we resolve the path relative to the previewed file's
 * directory, fetch the bytes through the `read-image` endpoint, and hand the
 * `<img>` a `blob:` object URL (which the CSP allows).
 *
 * Wired into the generic Markdown renderer via `MarkdownImageProvider`; the
 * per-file resolution context is supplied through `PreviewImageProvider`.
 */
import { createContext, useContext, type ReactElement } from "react";
import { useQuery } from "@tanstack/react-query";
import { ImageOffIcon, Loader2Icon } from "lucide-react";
import { apiErrorMessage } from "@/lib/api-errors";
import { isImageFile } from "@/lib/file-language";
import { readImageBlob, readImageBlobQueryKey } from "@/lib/read-image-blob";
import { useObjectUrl } from "@/hooks/useObjectUrl";
import { PlainMarkdownImage, type MarkdownImageProps } from "@/components/markdown-image";

interface PreviewImageContextValue {
  projectId: number;
  featureId: number;
  /** Directory of the previewed file, relative to the project root. */
  baseDir: string;
}

const PreviewImageContext = createContext<PreviewImageContextValue | null>(null);
export const PreviewImageProvider = PreviewImageContext.Provider;

/**
 * Resolve a markdown image `src` (relative to the previewed file's directory)
 * to a project-root-relative POSIX path, or `null` when the `src` is a remote
 * or inline URL (`http:`, `data:`, `blob:`, protocol-relative) that should
 * render unchanged. A leading `/` is treated as repo-root-relative, matching
 * the GitHub convention.
 */
export function resolvePreviewImagePath(baseDir: string, src: string): string | null {
  if (!src) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith("//")) return null;
  const clean = src.split(/[?#]/)[0];
  const base = clean.startsWith("/") ? "" : baseDir;
  const stack: string[] = [];
  for (const segment of `${base}/${clean}`.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") stack.pop();
    else stack.push(segment);
  }
  return stack.join("/") || null;
}

export function PreviewMarkdownImage(props: MarkdownImageProps): ReactElement {
  const context = useContext(PreviewImageContext);
  const resolved =
    context && props.src ? resolvePreviewImagePath(context.baseDir, props.src) : null;
  // `read-image` only serves the bitmap formats `isImageFile` allows; everything
  // else (remote URLs, unsupported local files like `.svg`) falls through to a
  // plain <img>.
  if (context && resolved && isImageFile(resolved)) {
    return (
      <LocalPreviewImage
        projectId={context.projectId}
        featureId={context.featureId}
        filePath={resolved}
        {...props}
      />
    );
  }
  return <PlainMarkdownImage {...props} />;
}

interface LocalPreviewImageProps extends MarkdownImageProps {
  projectId: number;
  featureId: number;
  filePath: string;
}

function LocalPreviewImage({
  projectId,
  featureId,
  filePath,
  src,
  alt,
  title,
  width,
  height,
}: LocalPreviewImageProps): ReactElement {
  const { t } = useUiTranslation();
  const query = useQuery({
    queryKey: readImageBlobQueryKey(projectId, featureId, filePath),
    queryFn: ({ signal }) => readImageBlob(projectId, featureId, filePath, signal),
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const objectUrl = useObjectUrl(query.data);

  if (query.error) {
    const message = apiErrorMessage(
      query.error,
      t("workspace.editor.previewMarkdownImage.loadFailed", "Failed to load image"),
    );
    return (
      <span
        title={message}
        className="my-2 inline-flex items-center gap-1.5 rounded border border-border bg-muted px-2 py-1 text-xs text-muted-foreground"
      >
        <ImageOffIcon className="size-3.5 shrink-0" />
        <span className="truncate">{alt || src}</span>
      </span>
    );
  }

  if (!objectUrl) {
    return (
      <span className="my-2 inline-flex items-center gap-1.5 rounded border border-border bg-muted px-2 py-1 text-xs text-muted-foreground">
        <Loader2Icon className="size-3.5 shrink-0 animate-spin" />
        <span className="truncate">{alt || src}</span>
      </span>
    );
  }

  return (
    <img
      src={objectUrl}
      alt={alt ?? ""}
      title={title}
      width={width}
      height={height}
      className="my-2 h-auto max-w-full rounded"
    />
  );
}
