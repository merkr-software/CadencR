import { useUiTranslation, type translateUi } from "@/lib/i18n/ui";
import { useEffect, useRef } from "react";
import { useIsFetching, useIsMutating, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

/**
 * Hosts the global in-flight-operation toast as a childless leaf.
 *
 * The hook below subscribes to `useIsFetching()` / `useIsMutating()` —
 * two `useSyncExternalStore` counters over the whole query cache. They tick on
 * *every* request the app makes, so the component that owns them re-renders
 * twice per request (0 → 1 → 0). This hook used to be called directly from
 * `RootLayout`, which put the entire application under those two counters:
 * measured at 927 component re-renders per tick, ~1 850 per request, for a
 * hook whose only output is a toast. Loading a page of conversation history
 * cost two full-app re-renders; a phone opening the app fires 20–30 requests a
 * second.
 *
 * Rendering it here instead confines the subscription to this leaf, which
 * renders nothing. Keep it that way: it must never take children.
 */
export function GlobalOperationToasts(): null {
  useOperationToasts();
  return null;
}

const TOAST_ID = "global-ops";

/** Maps React Query keys to friendly, non-technical labels */
const OPERATION_LABELS: Record<string, string> = {};

/** Excluded prefixes — high-frequency polling/streaming queries that shouldn't show toasts */
const EXCLUDED_PREFIXES = ["agents.", "sessions.", "features."];

/** Converts a query key like "diffComments.getByFeature" into "Loading diff comments" */
function humanizeKey(t: typeof translateUi, key: string): string {
  // Take the router name (first segment), split camelCase, and title-case it
  const router = key.split(".")[0];
  const words = router.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
  return t("shell.operations.loading", "Loading {{name}}", { name: words });
}

function extractOperationKey(queryKey: readonly unknown[]): string | null {
  // Expects tRPC-shaped keys — `[["git", "getStats"], { input: … }]`.
  // NOTE: every query in the app is orval-generated and keyed
  // `["/api/git/stats", params]`, i.e. `first` is a string, so this returns
  // `null` for all of them and the toast below never renders. Left as-is
  // because making it fire is a product decision, not a perf fix: matching on
  // the URL shape would also need `EXCLUDED_PREFIXES` rewritten to `/api/…`,
  // or every git/settings poll would raise a toast.
  const first = queryKey[0];
  if (Array.isArray(first) && first.length >= 2 && typeof first[0] === "string") {
    const key = first.join(".");
    if (EXCLUDED_PREFIXES.some((p) => key.startsWith(p))) return null;
    return key;
  }
  return null;
}

function useOperationToasts(): void {
  const { t } = useUiTranslation();
  const queryClient = useQueryClient();
  const fetchCount = useIsFetching();
  const mutateCount = useIsMutating();
  const prevActiveRef = useRef(false);

  useEffect(() => {
    const totalActive = fetchCount + mutateCount;

    if (totalActive === 0) {
      if (prevActiveRef.current) {
        toast.dismiss(TOAST_ID);
      }
      prevActiveRef.current = false;
      return;
    }

    // Gather active operation names from query cache
    const activeOps: string[] = [];

    const queries = queryClient.getQueryCache().findAll({ fetchStatus: "fetching" });
    for (const query of queries) {
      const key = extractOperationKey(query.queryKey);
      if (key) {
        activeOps.push(OPERATION_LABELS[key] ?? humanizeKey(t, key));
      }
    }

    const mutations = queryClient.getMutationCache().findAll({ status: "pending" });
    for (const mutation of mutations) {
      const key = extractOperationKey(mutation.options.mutationKey ?? []);
      if (key) {
        activeOps.push(OPERATION_LABELS[key] ?? humanizeKey(t, key));
      }
    }

    // Deduplicate
    const unique = [...new Set(activeOps)];
    if (unique.length === 0) {
      // Active requests exist but all are excluded — don't show toast
      if (prevActiveRef.current) {
        toast.dismiss(TOAST_ID);
        prevActiveRef.current = false;
      }
      return;
    }

    const display = unique.slice(0, 5);
    const extra = unique.length - display.length;
    const lines = [...display];
    if (extra > 0)
      lines.push(t("shell.operations.more", "and {{count}} more...", { count: extra }));

    toast.loading(
      <div className="flex flex-col gap-0.5">
        {lines.map((line, i) => (
          <span key={i}>{line}</span>
        ))}
      </div>,
      {
        id: TOAST_ID,
        icon: <Loader2 className="size-4 animate-spin text-muted-foreground" />,
      },
    );
    prevActiveRef.current = true;
  }, [fetchCount, mutateCount, queryClient, t]);
}
