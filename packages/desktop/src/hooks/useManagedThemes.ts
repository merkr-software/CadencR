import { translateUi } from "@/lib/i18n/ui";
import { useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { getManagedThemes } from "@/api/generated";
import {
  managedThemeEntrySchema,
  managedThemeDefinition,
  managedThemeInventoryError,
  managedThemesKey,
  parseManagedThemeResponse,
} from "@/lib/theme-marketplace";
import { setManagedThemes } from "@/lib/themes/user-registry";

export function useManagedThemes() {
  return useQuery({
    queryKey: managedThemesKey,
    staleTime: 60_000,
    refetchInterval: 15 * 60_000,
    refetchIntervalInBackground: true,
    queryFn: async ({ signal }) => {
      const entries = await getManagedThemes(signal);
      return parseManagedThemeResponse(managedThemeEntrySchema.array(), entries);
    },
  });
}
function useManagedThemeRegistry(): void {
  const query = useManagedThemes();
  const definitions = useMemo(
    () => query.data?.filter((entry) => entry.theme?.theme).map(managedThemeDefinition),
    [query.data],
  );
  useEffect(() => {
    if (definitions) setManagedThemes(definitions);
  }, [definitions]);
  useEffect(() => {
    if (!query.error) return;
    toast.error(managedThemeInventoryError(query.error, translateUi), {
      id: "managed-themes-load",
    });
  }, [query.error]);
}

/** Mounted once at the root: keeps the theme registry in sync with installed marketplace themes. */
export function ManagedThemeRegistry() {
  useManagedThemeRegistry();
  return null;
}
