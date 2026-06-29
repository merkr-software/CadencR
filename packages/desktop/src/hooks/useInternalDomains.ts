import { useMemo } from "react";
import { useDebouncedSetting } from "@/hooks/useDebouncedSetting";
import { INTERNAL_DOMAINS_SETTING_KEY, parseInternalDomains } from "@/lib/link-routing";

/**
 * Read-only view of the user's "open in Cadencr's browser" domain list
 * (Settings → Browser). Reads the setting once and memoizes the parsed array
 * so a single provider can hand it to many link consumers without a
 * per-link subscription.
 */
export function useInternalDomains(): string[] {
  const { value } = useDebouncedSetting(INTERNAL_DOMAINS_SETTING_KEY, 0);
  return useMemo(() => parseInternalDomains(value), [value]);
}
