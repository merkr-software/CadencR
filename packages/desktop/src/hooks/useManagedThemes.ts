import { useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { getManagedThemes } from "@/api/generated";
import {
  managedThemeEntrySchema,
  managedThemeDefinition,
  managedThemesKey,
} from "@/lib/theme-marketplace";
import { setManagedThemes } from "@/lib/themes/user-registry";
import { apiErrorMessage } from "@/lib/api-errors";

export function useManagedThemes() {
  return useQuery({
    queryKey: managedThemesKey,
    staleTime: 60_000,
    refetchInterval: 15 * 60_000,
    refetchIntervalInBackground: true,
    queryFn: async ({ signal }) => {
      const entries = await getManagedThemes(signal);
      return managedThemeEntrySchema.array().parse(entries);
    },
  });
}
export function useManagedThemeRegistry(): void {
  const query = useManagedThemes();
  const definitions = useMemo(
    () => query.data?.filter((entry) => entry.theme?.theme).map(managedThemeDefinition),
    [query.data],
  );
  useEffect(() => {
    if (definitions) setManagedThemes(definitions);
  }, [definitions]);
  useEffect(() => {
    if (query.error)
      toast.error(apiErrorMessage(query.error, "Could not load installed marketplace themes"));
  }, [query.error]);
}
