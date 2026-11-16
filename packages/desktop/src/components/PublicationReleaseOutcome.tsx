import { CheckCircle2, ExternalLink, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { openExternalUrl } from "@/lib/open-external";
import { PublicationOperationsStatus } from "./PublicationOperationsStatus";
import { PublicationError } from "./PublicationError";

function ReleasePublicationStatus({
  error,
  pending,
  publishedUrl,
}: {
  error: unknown;
  pending: boolean;
  publishedUrl: string | null;
}): React.JSX.Element {
  return (
    <>
      {error ? (
        <PublicationError prefix="Could not publish the GitHub release" error={error} />
      ) : null}
      {pending ? (
        <div role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" aria-hidden /> Publishing GitHub release…
        </div>
      ) : null}
      {publishedUrl ? <PublishedRelease releaseUrl={publishedUrl} /> : null}
    </>
  );
}

function PublishedRelease({ releaseUrl }: { releaseUrl: string }): React.JSX.Element {
  return (
    <div
      role="status"
      className="space-y-2 rounded-lg border border-[var(--acc-green)]/30 bg-[var(--acc-green)]/5 p-3 text-sm"
    >
      <p className="flex items-center gap-2 font-medium text-[var(--acc-green)]">
        <CheckCircle2 className="size-4" aria-hidden /> GitHub release published
      </p>
      <Button
        type="button"
        variant="link"
        className="h-auto justify-start whitespace-normal break-all p-0"
        onClick={() => void openExternalUrl(releaseUrl, "Could not open the GitHub release.")}
      >
        {releaseUrl} <ExternalLink className="size-3" aria-hidden />
      </Button>
    </div>
  );
}

export function ReleaseOutcome({
  projectId,
  registryPending,
  operationId,
  mutation,
  publishedUrl,
}: {
  projectId: number;
  registryPending: boolean;
  operationId?: string;
  mutation: { isPending: boolean; isError: boolean; error: unknown };
  publishedUrl: string | null;
}): React.JSX.Element {
  return (
    <>
      <PublicationOperationsStatus
        projectId={projectId}
        publicationPending={mutation.isPending || registryPending}
        operationId={operationId}
      />
      <ReleasePublicationStatus
        error={mutation.isError ? mutation.error : null}
        pending={mutation.isPending}
        publishedUrl={publishedUrl}
      />
    </>
  );
}
