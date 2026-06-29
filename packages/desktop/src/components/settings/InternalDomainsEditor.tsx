import { useMemo, useState, type ReactElement } from "react";
import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useDebouncedSetting } from "@/hooks/useDebouncedSetting";
import {
  INTERNAL_DOMAINS_SETTING_KEY,
  parseInternalDomains,
  serializeInternalDomains,
} from "@/lib/link-routing";

/** Reduce free-form input ("http://foo.com:3000/x", "Sub.Example.com") to a host. */
function normalizeDomain(input: string): string | null {
  const trimmed = input.trim().toLowerCase();
  if (trimmed.length === 0) return null;
  try {
    const url = new URL(trimmed.includes("://") ? trimmed : `http://${trimmed}`);
    return url.hostname.length > 0 ? url.hostname : null;
  } catch {
    return null;
  }
}

/**
 * Add/remove editor for the domains whose links open in Cadencr's own browser
 * tab. Persists the list as a JSON array in one workspace setting.
 */
export function InternalDomainsEditor(): ReactElement {
  const { value, setValue, isLoading } = useDebouncedSetting(INTERNAL_DOMAINS_SETTING_KEY, 0);
  const [draft, setDraft] = useState("");
  const domains = useMemo(() => parseInternalDomains(value), [value]);

  const addDomain = (): void => {
    const domain = normalizeDomain(draft);
    if (!domain || domains.includes(domain)) {
      setDraft("");
      return;
    }
    setValue(serializeInternalDomains([...domains, domain]));
    setDraft("");
  };

  const removeDomain = (domain: string): void => {
    setValue(serializeInternalDomains(domains.filter((entry) => entry !== domain)));
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {domains.length === 0 ? (
          <span className="text-sm text-muted-foreground">
            No domains — every link opens in the system browser.
          </span>
        ) : (
          domains.map((domain) => (
            <span
              key={domain}
              className="inline-flex items-center gap-1 rounded-md border border-border bg-muted px-2 py-1 text-sm"
            >
              {domain}
              <button
                type="button"
                aria-label={`Remove ${domain}`}
                onClick={() => removeDomain(domain)}
                disabled={isLoading}
                className="text-muted-foreground hover:text-foreground disabled:opacity-50"
              >
                <X className="size-3.5" />
              </button>
            </span>
          ))
        )}
      </div>
      <div className="flex gap-2">
        <Input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              addDomain();
            }
          }}
          placeholder="localhost, example.com…"
          disabled={isLoading}
          className="max-w-xs"
        />
        <Button type="button" variant="outline" onClick={addDomain} disabled={isLoading}>
          <Plus className="size-4" />
          Add
        </Button>
      </div>
    </div>
  );
}
