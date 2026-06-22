/**
 * Document-symbol quick picker (Cmd+Shift+O). Reuses the fuzzy-picker UI
 * (`CommandDialog`) the file finder uses. Symbols come from
 * `textDocument/documentSymbol`, indented by depth; selecting one moves the
 * cursor to it. `cmdk`'s built-in filtering handles the fuzzy match.
 */
import { useEffect, useState } from "react";
import type { EditorView } from "@codemirror/view";
import { EditorView as CMView } from "@codemirror/view";
import { toast } from "sonner";
import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandItem,
  CommandEmpty,
} from "@/components/ui/command";
import { documentSymbols, canDocumentSymbols, type FlatSymbol } from "@/lib/lsp/document-symbols";
import { symbolKindLabel } from "@/lib/lsp/lsp-position";

interface EditorSymbolPickerProps {
  view: EditorView;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function EditorSymbolPicker({ view, open, onOpenChange }: EditorSymbolPickerProps) {
  const [symbols, setSymbols] = useState<FlatSymbol[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (!canDocumentSymbols(view)) {
      toast.info("This language server doesn't support document symbols.");
      onOpenChange(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void documentSymbols(view)
      .then((result) => {
        if (!cancelled) setSymbols(result);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        toast.error(`Symbols unavailable: ${err instanceof Error ? err.message : String(err)}`);
        onOpenChange(false);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, view, onOpenChange]);

  const handleSelect = (symbol: FlatSymbol): void => {
    view.dispatch({
      selection: { anchor: symbol.selectionFrom },
      effects: CMView.scrollIntoView(symbol.selectionFrom, { y: "center" }),
    });
    view.focus();
    onOpenChange(false);
  };

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandInput placeholder="Go to symbol in file..." />
      <CommandList>
        {loading && symbols.length === 0 && (
          <div className="py-6 text-center text-sm text-muted-foreground">Loading…</div>
        )}
        {!loading && symbols.length === 0 && <CommandEmpty>No symbols found.</CommandEmpty>}
        {symbols.map((symbol, index) => (
          <CommandItem
            // Symbol names repeat (overloads, nested scopes); index keeps keys unique.
            key={`${symbol.name}-${symbol.selectionFrom}-${index}`}
            value={`${symbol.name} ${index}`}
            onSelect={() => handleSelect(symbol)}
          >
            <span style={{ paddingLeft: `${symbol.depth * 12}px` }} className="truncate">
              {symbol.name}
            </span>
            <span className="ml-auto text-xs text-muted-foreground shrink-0">
              {symbolKindLabel(symbol.kind)}
            </span>
          </CommandItem>
        ))}
      </CommandList>
    </CommandDialog>
  );
}
