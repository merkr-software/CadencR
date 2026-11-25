import { useUiTranslation } from "@/lib/i18n/ui";
import { apiErrorMessage } from "@/lib/api-errors";

export function PublicationError({
  prefix,
  error,
}: {
  prefix: string;
  error: unknown;
}): React.JSX.Element {
  const { t } = useUiTranslation();
  return (
    <div
      role="alert"
      className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
    >
      {t("marketplace.publication.errorWithReason", "{{prefix}}: {{error}}", {
        prefix,
        error: apiErrorMessage(error, t("common.unknownError", "Unknown error")),
      })}
    </div>
  );
}
