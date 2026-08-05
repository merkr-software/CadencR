import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { comboSearchText, formatCombo, PLATFORM_IS_MAC } from "@/lib/shortcuts/format";
import { SHORTCUTS_BY_SCOPE, TOTAL_SHORTCUTS, type Shortcut } from "@/lib/shortcuts/registry";
import { getRegistryShortcut } from "@/lib/shortcuts/resolve";

const COMMAND_PALETTE_COMBO = formatCombo(getRegistryShortcut("command-palette").keys).join(" ");

interface KeyboardShortcutsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Live `⌘⇧?` reference. Renders straight from `lib/shortcuts/registry` so
 * adding or removing a real shortcut keeps this view in sync. Includes a
 * fuzzy search across description + alias + visible combo so a user looking
 * for "zoom" or "⌘ 0" finds the right row regardless of how they think
 * about the binding.
 */
export function KeyboardShortcutsModal({ open, onOpenChange }: KeyboardShortcutsModalProps) {
  const [query, setQuery] = useState("");

  const filteredGroups = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return SHORTCUTS_BY_SCOPE;
    return SHORTCUTS_BY_SCOPE.map((g) => ({
      ...g,
      items: g.items.filter((item) => matchesQuery(item, q)),
    })).filter((g) => g.items.length > 0);
  }, [query]);

  const totalShown = useMemo(
    () => filteredGroups.reduce((acc, g) => acc + g.items.length, 0),
    [filteredGroups],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] w-[92vw] flex-col gap-0 overflow-hidden p-0 sm:max-w-[920px]">
        <DialogHeader className="border-b border-border px-5 pt-4 pb-3 space-y-3">
          <DialogTitle className="pr-8 text-base font-semibold">Keyboard shortcuts</DialogTitle>
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={`Search shortcuts — try “zoom”, “git”, or “${COMMAND_PALETTE_COMBO}”…`}
              className="h-8 pl-8 pr-32 text-sm"
              aria-label="Search shortcuts"
            />
            <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[11px] text-muted-foreground">
              {PLATFORM_IS_MAC ? "macOS" : "Windows / Linux"} · {totalShown} of {TOTAL_SHORTCUTS}
            </span>
          </div>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {filteredGroups.length === 0 ? (
            <div className="grid place-items-center py-12 text-sm text-muted-foreground">
              No shortcuts match “{query}”.
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-x-8 gap-y-6 md:grid-cols-2">
              {filteredGroups.map((group) => (
                <section key={group.scope.id} className="space-y-2">
                  <header className="border-b border-border pb-1.5">
                    <h3 className="text-[11px] font-semibold uppercase tracking-wider text-foreground">
                      {group.scope.label}
                    </h3>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">{group.scope.hint}</p>
                  </header>
                  <ul className="divide-y divide-border/40">
                    {group.items.map((item) => (
                      <ShortcutRow key={item.id} item={item} />
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          )}
        </div>

        <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-border bg-card px-5 py-2 text-[11px] text-muted-foreground">
          <Combo keys={["Esc"]} /> to close
        </footer>
      </DialogContent>
    </Dialog>
  );
}

function ShortcutRow({ item }: { item: Shortcut }) {
  return (
    <li className="flex min-h-[28px] items-center justify-between gap-4 py-1">
      <span className="text-sm text-foreground">{item.description}</span>
      <div className="flex shrink-0 items-center gap-1">
        {item.altKeys && (
          <>
            <Combo keys={formatCombo(item.altKeys)} />
            <span className="text-[10px] text-muted-foreground">or</span>
          </>
        )}
        <Combo keys={formatCombo(item.keys)} />
      </div>
    </li>
  );
}

/** Plain-text chord rendering — uses pre-formatted strings from `format.ts`
 *  so platform glyphs are honored without `KbdShortcut`'s implicit icon
 *  remapping ("Ctrl" → ⌃ etc.). */
function Combo({ keys }: { keys: string[] }) {
  return (
    <kbd className="inline-flex items-center gap-1 rounded border border-border bg-card px-2 py-1 font-mono text-[11px] font-medium text-foreground shadow-sm">
      {keys.map((k, i) => (
        <span key={i} className="leading-none">
          {k}
        </span>
      ))}
    </kbd>
  );
}

function matchesQuery(item: Shortcut, q: string): boolean {
  if (item.description.toLowerCase().includes(q)) return true;
  if (item.aliases?.some((a) => a.toLowerCase().includes(q))) return true;
  if (comboSearchText(item.keys).includes(q)) return true;
  if (item.altKeys && comboSearchText(item.altKeys).includes(q)) return true;
  return false;
}
