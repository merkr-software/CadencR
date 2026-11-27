import { translateUi } from "@/lib/i18n/ui";
import { Loader2 } from "lucide-react";
import type { ReactNode } from "react";
import { toast } from "sonner";

export function LoadingRow({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-border px-4 py-3 text-sm text-muted-foreground">
      <Loader2 className="size-3.5 animate-spin" /> {label}
    </div>
  );
}

export function ErrorRow({ label }: { label: ReactNode }) {
  return (
    <div className="rounded-md border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive">
      {label}
    </div>
  );
}

/** Success + error toast callbacks for a settings mutation. */
export function toastCallbacks(
  successMessage: () => string,
  errorPrefix: () => string,
  onSuccess?: () => void,
) {
  return {
    onSuccess: () => {
      toast.success(successMessage());
      onSuccess?.();
    },
    onError: (error: unknown) =>
      toast.error(
        translateUi("settings.providers.mutationError", "{{action}}: {{message}}", {
          action: errorPrefix(),
          message:
            (error as Error)?.message ??
            translateUi("settings.providers.unknownError", "unknown error"),
        }),
      ),
  };
}
