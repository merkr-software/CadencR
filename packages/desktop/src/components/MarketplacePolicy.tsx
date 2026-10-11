import type { ManagedProvidersInventory } from "@/api/generated";

export function MarketplacePolicy({
  inventory,
}: {
  inventory: ManagedProvidersInventory;
}): React.JSX.Element {
  const controls = [
    ["Memory limit", inventory.process_policy.memory_limit],
    ["Child-process limit", inventory.process_policy.child_count_limit],
    ["CPU limit", inventory.process_policy.cpu_limit],
    ["Descendant termination", inventory.process_policy.descendant_termination],
  ] as const;
  return (
    <div className="space-y-2 text-muted-foreground">
      <p>
        Blocklist source: {inventory.blocklist.source_configured ? "configured" : "not configured"}{" "}
        · cache: {inventory.blocklist.cache_status}.
        {inventory.blocklist.cache_status !== "verified"
          ? " No verified blocklist policy is available."
          : ""}
      </p>
      {controls
        .filter(([, outcome]) => outcome.status === "unavailable")
        .map(([label, outcome]) => (
          <p key={label}>
            {label}: unavailable{outcome.status === "unavailable" ? ` — ${outcome.reason}` : ""}
          </p>
        ))}
      <p>
        Package integrity and process controls are not an OS sandbox. Installed provider executables
        run on your host; use an isolated environment for untrusted providers.
      </p>
    </div>
  );
}
