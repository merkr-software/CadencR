import { useEffect } from "react";
import { toast } from "sonner";
import { apiErrorMessage } from "@/lib/api-errors";

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
export function useQueryErrorToast(query: QueryErrorState, label: string, id: string): void {
  const message = query.isError ? apiErrorMessage(query.error, "Unknown error") : null;
  useEffect(() => {
    if (!message) return;
    toast.error(`${label}: ${message}`, { id });
    return () => {
      toast.dismiss(id);
    };
  }, [id, label, message]);
}
