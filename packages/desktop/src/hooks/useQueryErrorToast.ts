import { useEffect } from "react";
import { toast } from "sonner";
import { apiErrorMessage } from "@/lib/api-errors";
import { localizedToastText } from "@/lib/i18n/toast-text";
import type { UiTranslator } from "@/lib/i18n/ui";

interface QueryErrorState {
  isError: boolean;
  error: unknown;
}

/**
 * Surface a background query's failure as one toast per `id`, dismissed once
 * the query recovers or the view unmounts. For queries whose result only
 * decorates a view (editor gutter markers, inline blame), where an empty result
 * would otherwise pass for "nothing to show".
 */
export function useQueryErrorToast(
  query: QueryErrorState,
  label: (t: UiTranslator) => string,
  id: string,
): void {
  const message = query.isError ? apiErrorMessage(query.error, "") : null;
  useEffect(() => {
    if (message === null) return;
    toast.error(
      localizedToastText((t) =>
        t("common.labelWithDetail", "{{label}}: {{detail}}", {
          label: label(t),
          detail: message || t("common.unknownError", "Unknown error"),
        }),
      ),
      { id },
    );
    return () => {
      toast.dismiss(id);
    };
  }, [id, label, message]);
}
