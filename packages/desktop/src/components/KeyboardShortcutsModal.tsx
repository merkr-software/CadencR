import { memo, useMemo, useState } from "react";
import { Search } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { KbdChord } from "@/components/KbdShortcut";
import { useCustomTabShortcutGroups } from "@/components/plugin-tabs/useCustomTabShortcutGroups";
import { comboSearchText, formatCombo, PLATFORM_IS_MAC } from "@/lib/shortcuts/format";
import { SHORTCUTS_BY_SCOPE, type ShortcutKey } from "@/lib/shortcuts/registry";
import { getRegistryShortcut } from "@/lib/shortcuts/resolve";

const COMMAND_PALETTE_COMBO = formatCombo(getRegistryShortcut("command-palette").keys).join(" ");

interface KeyboardShortcutsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Its custom tabs' own shortcuts are listed after Cadencr's. */
  projectId: number | null;
}

interface ShortcutItem {
  id: string;
  keys: ShortcutKey[];
  altKeys?: ShortcutKey[];
  description: string;
  aliases?: string[];
}

interface ShortcutGroup {
  id: string;
  label: string;
  hint: string;
  items: ShortcutItem[];
}

const CADENCR_GROUPS: ShortcutGroup[] = SHORTCUTS_BY_SCOPE.map(({ scope, items }) => ({
  id: scope.id,
  label: scope.label,
  hint: scope.hint,
  items,
}));

/**
 * Live `⌘⇧?` reference. Renders straight from `lib/shortcuts/registry` so
 * adding or removing a real shortcut keeps this view in sync. Includes a
 * fuzzy search across description + alias + visible combo so a user looking
 * for "zoom" or "⌘ 0" finds the right row regardless of how they think
 * about the binding.
 */
export function KeyboardShortcutsModal({
  open,
  onOpenChange,
  projectId,
}: KeyboardShortcutsModalProps) {
  const [query, setQuery] = useState("");
  const tabGroups = useCustomTabShortcutGroups(projectId, open);
  const groups = useMemo(() => [...CADENCR_GROUPS, ...tabGroups], [tabGroups]);
  const total = useMemo(() => groups.reduce((acc, g) => acc + g.items.length, 0), [groups]);

  const filteredGroups = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return groups;
    return groups
      .map((g) => ({
        ...g,
        items: g.items.filter((item) => matchesQuery(item, q)),
      }))
      .filter((g) => g.items.length > 0);
  }, [groups, query]);

  const totalShown = useMemo(
    () => filteredGroups.reduce((acc, g) => acc + g.items.length, 0),
    [filteredGroups],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[min(85vh,var(--dialog-max-h))] w-[92vw] flex-col gap-0 overflow-hidden p-0 sm:max-w-[920px]">
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
              {PLATFORM_IS_MAC ? "macOS" : "Windows / Linux"} · {totalShown} of {total}
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
                <section key={group.id} className="space-y-2">
                  <header className="border-b border-border pb-1.5">
                    <h3 className="text-[11px] font-semibold uppercase tracking-wider text-foreground">
                      {group.label}
                    </h3>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">{group.hint}</p>
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
          <KbdChord keys={["Esc"]} /> to close
        </footer>
      </DialogContent>
    </Dialog>
  );
}

// Memoized: items come from the static registry, so typing in the search box
// only re-renders rows that appear or disappear, not every key cap.
const ShortcutRow = memo(function ShortcutRow({ item }: { item: ShortcutItem }) {
  return (
    <li className="flex min-h-[28px] items-center justify-between gap-4 py-1">
      <span className="text-sm text-foreground">{item.description}</span>
      <div className="flex shrink-0 items-center gap-1">
        {item.altKeys && (
          <>
            <KbdChord keys={formatCombo(item.altKeys)} />
            <span className="text-[10px] text-muted-foreground">or</span>
          </>
        )}
        <KbdChord keys={formatCombo(item.keys)} />
      </div>
    </li>
  );
});

function matchesQuery(item: ShortcutItem, q: string): boolean {
  if (item.description.toLowerCase().includes(q)) return true;
  if (item.aliases?.some((a) => a.toLowerCase().includes(q))) return true;
  if (comboSearchText(item.keys).includes(q)) return true;
  if (item.altKeys && comboSearchText(item.altKeys).includes(q)) return true;
  return false;
}
