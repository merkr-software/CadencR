import type { PluginTabSummary } from "@/api/generated";
import { KbdChord } from "@/components/KbdShortcut";
import { useResolvedTabShortcuts } from "@/components/plugin-tabs/useTabShortcuts";
import { formatCombo } from "@/lib/shortcuts/format";

/**
 * The keyboard shortcuts a tab handles while it has focus. Cadencr's own
 * always win: one on the same keys is listed as not available, with the
 * Cadencr shortcut that takes them.
 */
export function CustomTabShortcuts({
  tab,
}: {
  tab: Pick<PluginTabSummary, "shortcuts">;
}): React.JSX.Element {
  const resolved = useResolvedTabShortcuts(tab.shortcuts);
  return (
    <ul className="space-y-2" aria-label="Keyboard shortcuts">
      {resolved.map(({ shortcut, takenBy }) => (
        <li key={shortcut.id} className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-xs font-medium leading-tight">{shortcut.description}</p>
            {takenBy ? (
              <p className="mt-0.5 text-xs leading-snug text-muted-foreground">
                Not available: Cadencr uses these keys for “{takenBy.description}”.
              </p>
            ) : null}
          </div>
          <span className={takenBy ? "shrink-0 opacity-50" : "shrink-0"}>
            <KbdChord keys={formatCombo(shortcut.keys)} />
          </span>
        </li>
      ))}
    </ul>
  );
}
