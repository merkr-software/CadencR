import { apiErrorMessage } from "@/lib/api-errors";

export function PublicationError({
  prefix,
  error,
}: {
  prefix: string;
  error: unknown;
}): React.JSX.Element {
  return (
    <div
      role="alert"
      className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
    >
      {prefix}: {apiErrorMessage(error, "Unknown error")}
    </div>
  );
}
