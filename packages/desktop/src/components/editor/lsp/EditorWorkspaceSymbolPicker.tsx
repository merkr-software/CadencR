/**
 * Workspace-symbol quick picker (Cmd+T). Reuses the fuzzy-picker UI and
 * queries `workspace/symbol` as the user types (debounced). Unlike the file
 * symbol picker, filtering happens server-side, so `cmdk`'s client filter is
 * disabled. Selecting a symbol jumps to its location via `openLspLocation`.
 */
import { useEffect, useState } from "react";
import type { EditorView } from "@codemirror/view";
import { toast } from "sonner";
import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandItem,
  CommandEmpty,
} from "@/components/ui/command";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import {
  workspaceSymbols,
  canWorkspaceSymbols,
  type WorkspaceSymbolResult,
} from "@/lib/lsp/workspace-symbols";
import { openLspLocation, symbolKindLabel } from "@/lib/lsp/lsp-position";

interface EditorWorkspaceSymbolPickerProps {
  view: EditorView;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const DEBOUNCE_MS = 200;

export function EditorWorkspaceSymbolPicker({
  view,
  open,
  onOpenChange,
}: EditorWorkspaceSymbolPickerProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<WorkspaceSymbolResult[]>([]);
  const [loading, setLoading] = useState(false);
  const debounced = useDebouncedValue(query, DEBOUNCE_MS);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    if (!canWorkspaceSymbols(view)) {
      toast.info("This language server doesn't support workspace symbols.");
      onOpenChange(false);
    }
  }, [open, view, onOpenChange]);

  useEffect(() => {
    if (!open || debounced.trim() === "") {
      setResults([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void workspaceSymbols(view, debounced)
      .then((result) => {
        if (!cancelled) setResults(result);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        toast.error(`Symbol search failed: ${err instanceof Error ? err.message : String(err)}`);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, debounced, view]);

  const handleSelect = async (symbol: WorkspaceSymbolResult): Promise<void> => {
    try {
      const target = await openLspLocation(view, symbol.location);
      if (!target) {
        toast.error("Could not open the symbol location.");
        return;
      }
      onOpenChange(false);
    } catch (err) {
      toast.error(`Failed to open symbol: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} commandProps={{ shouldFilter: false }}>
      <CommandInput
        placeholder="Go to symbol in workspace..."
        value={query}
        onValueChange={setQuery}
      />
      <CommandList>
        {query.trim() === "" && (
          <div className="py-6 text-center text-sm text-muted-foreground">
            Type to search workspace symbols.
          </div>
        )}
        {loading && results.length === 0 && query.trim() !== "" && (
          <div className="py-6 text-center text-sm text-muted-foreground">Searching…</div>
        )}
        {!loading && query.trim() !== "" && results.length === 0 && (
          <CommandEmpty>No symbols found.</CommandEmpty>
        )}
        {results.map((symbol, index) => (
          <CommandItem
            key={`${symbol.name}-${symbol.location.uri}-${index}`}
            value={`${symbol.name} ${index}`}
            onSelect={() => void handleSelect(symbol)}
          >
            <span className="truncate">{symbol.name}</span>
            {symbol.containerName && (
              <span className="text-xs text-muted-foreground truncate">{symbol.containerName}</span>
            )}
            <span className="ml-auto text-xs text-muted-foreground shrink-0">
              {symbolKindLabel(symbol.kind)}
            </span>
          </CommandItem>
        ))}
      </CommandList>
    </CommandDialog>
  );
}
