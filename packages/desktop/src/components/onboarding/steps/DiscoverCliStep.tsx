import { AlertTriangle, CheckCircle2, XCircle } from "lucide-react";
import { useBinaryDiscovery, type ProviderDiscovery } from "@/api/generated";
import { Button } from "@/components/ui/button";
import { ErrorRow, LoadingRow } from "@/components/settings/SettingsStateRows";
import { OnboardingFooter } from "../OnboardingFooter";
import type { OnboardingStepProps } from "../OnboardingOverlay";

/**
 * Step 2 — list every provider returned by the binary discovery endpoint
 * with its detection status and a clear note that the user is responsible
 * for authenticating each CLI through its own harness (e.g. `claude login`,
 * `OPENAI_API_KEY`, etc.). Cadencr never stores credentials.
 *
 * The step is provider-neutral: it iterates over `BinaryDiscoveryResponse`
 * keys instead of hardcoding `["claude", "opencode", "codex"]`.
 */
export function DiscoverCliStep({
  isPersisting,
  onAdvance,
  onBack,
  onSkipStep,
}: OnboardingStepProps) {
  const query = useBinaryDiscovery();
  const providers = query.data?.providers ?? {};

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onAdvance();
      }}
      className="flex flex-col gap-6"
    >
      <header className="space-y-2">
        <h2 className="text-2xl font-semibold tracking-tight">Detect your agent CLIs</h2>
        <p className="text-sm text-muted-foreground">
          Cadencr runs your locally-installed agents — Claude, OpenCode, Codex — and shows their
          output here. We&apos;ll use whichever ones we can find.
        </p>
      </header>

      <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-sm flex items-start gap-2">
        <AlertTriangle className="size-4 text-amber-600 dark:text-amber-500 mt-0.5 shrink-0" />
        <div className="space-y-1">
          <p className="font-medium">You handle authentication</p>
          <p className="text-muted-foreground">
            Each CLI is responsible for its own auth (
            <code className="font-mono text-xs">claude login</code>,{" "}
            <code className="font-mono text-xs">OPENAI_API_KEY</code>, etc.). Cadencr never stores
            keys or tokens.
          </p>
        </div>
      </div>

      {query.isLoading ? (
        <LoadingRow label="Discovering installs…" />
      ) : query.isError ? (
        <ErrorRow
          label={
            <>
              Failed to detect installed CLIs.{" "}
              <Button type="button" variant="link" size="sm" onClick={() => void query.refetch()}>
                Retry
              </Button>
            </>
          }
        />
      ) : Object.keys(providers).length === 0 ? (
        <ErrorRow label="No agent providers reported by the backend." />
      ) : (
        <div className="rounded-md border border-border overflow-hidden divide-y divide-border">
          {Object.entries(providers).map(([id, p]) => (
            <ProviderRow key={id} id={id} provider={p} />
          ))}
        </div>
      )}

      <OnboardingFooter
        primaryLabel="Continue"
        primaryDisabled={isPersisting}
        onBack={onBack}
        onSkipStep={onSkipStep}
      />
    </form>
  );
}

function ProviderRow({ id, provider }: { id: string; provider: ProviderDiscovery }) {
  const detected = provider.selected != null;
  return (
    <div className="flex items-start justify-between gap-4 px-4 py-3 text-sm">
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex items-center gap-2">
          {detected ? (
            <CheckCircle2 className="size-4 text-emerald-600 dark:text-emerald-500" />
          ) : (
            <XCircle className="size-4 text-muted-foreground" />
          )}
          <span className="font-medium capitalize">{id}</span>
          <code className="text-xs text-muted-foreground font-mono">({provider.bin_name})</code>
        </div>
        {detected && provider.selected ? (
          <div className="text-xs text-muted-foreground pl-6 truncate">
            <code className="font-mono">{provider.selected.path}</code>
            {provider.selected.version ? ` (v${provider.selected.version})` : null}
          </div>
        ) : (
          <div className="text-xs text-muted-foreground pl-6">
            Not found — install the CLI on your machine, then click Continue.
          </div>
        )}
      </div>
    </div>
  );
}
