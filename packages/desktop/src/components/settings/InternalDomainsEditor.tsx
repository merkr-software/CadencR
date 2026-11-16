import { useMemo, useState, type ReactElement } from "react";
import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useSetting } from "@/hooks/useSetting";
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
  const { value, setValue, isLoading, isSaving } = useSetting(INTERNAL_DOMAINS_SETTING_KEY);
  const busy = isLoading || isSaving;
  const [draft, setDraft] = useState("");
  const domains = useMemo(() => parseInternalDomains(value), [value]);

  const addDomain = (): void => {
    if (busy) return;
    const domain = normalizeDomain(draft);
    if (!domain || domains.includes(domain)) {
      setDraft("");
      return;
    }
    // The domain joins the list once saved; a failed save keeps it in the field.
    void setValue(serializeInternalDomains([...domains, domain])).then((saved) => {
      if (saved) setDraft("");
    });
  };

  const removeDomain = (domain: string): void => {
    void setValue(serializeInternalDomains(domains.filter((entry) => entry !== domain)));
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {domains.length === 0 ? (
          <span className="text-sm text-muted-foreground">
            No domains. Every link opens in the system browser.
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
                disabled={busy}
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
        <Button type="button" variant="outline" onClick={addDomain} disabled={busy}>
          <Plus className="size-4" />
          Add
        </Button>
      </div>
    </div>
  );
}
