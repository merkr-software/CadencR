import { useUiTranslation, translateUi } from "@/lib/i18n/ui";
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
import { apiErrorMessage } from "@/lib/api-errors";
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
  const { t } = useUiTranslation();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<WorkspaceSymbolResult[]>([]);
  const [loading, setLoading] = useState(false);
  const debounced = useDebouncedValue(query, DEBOUNCE_MS);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    if (!canWorkspaceSymbols(view)) {
      toast.info(
        translateUi(
          "workspace.editor.workspaceSymbols.unsupported",
          "This language server doesn't support workspace symbols.",
        ),
      );
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
        toast.error(
          translateUi(
            "workspace.editor.workspaceSymbols.searchFailed",
            "Symbol search failed: {{error}}",
            { error: apiErrorMessage(err, String(err)) },
          ),
        );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, debounced, view]);

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} commandProps={{ shouldFilter: false }}>
      <CommandInput
        placeholder={t(
          "workspace.editor.workspaceSymbols.goToSymbolInWorkspace",
          "Go to symbol in workspace...",
        )}
        value={query}
        onValueChange={setQuery}
      />
      <CommandList>
        {query.trim() === "" && (
          <div className="py-6 text-center text-sm text-muted-foreground">
            {t(
              "workspace.editor.workspaceSymbols.typeToSearchWorkspaceSymbols",
              "Type to search workspace symbols.",
            )}
          </div>
        )}
        {loading && results.length === 0 && query.trim() !== "" && (
          <div className="py-6 text-center text-sm text-muted-foreground">
            {t("workspace.editor.workspaceSymbols.searching", "Searching…")}
          </div>
        )}
        {!loading && query.trim() !== "" && results.length === 0 && (
          <CommandEmpty>
            {t("workspace.editor.workspaceSymbols.noSymbolsFound", "No symbols found.")}
          </CommandEmpty>
        )}
        {results.map((symbol, index) => (
          <CommandItem
            key={`${symbol.name}-${symbol.location.uri}-${index}`}
            value={`${symbol.name} ${index}`}
            onSelect={() => void selectWorkspaceSymbol(view, symbol, onOpenChange)}
          >
            <span className="truncate">{symbol.name}</span>
            {symbol.containerName && (
              <span className="text-xs text-muted-foreground truncate">{symbol.containerName}</span>
            )}
            <span className="ml-auto text-xs text-muted-foreground shrink-0">
              {symbolKindLabel(symbol.kind, t)}
            </span>
          </CommandItem>
        ))}
      </CommandList>
    </CommandDialog>
  );
}

async function selectWorkspaceSymbol(
  view: EditorView,
  symbol: WorkspaceSymbolResult,
  onOpenChange: (open: boolean) => void,
): Promise<void> {
  try {
    const target = await openLspLocation(view, symbol.location);
    if (!target) {
      toast.error(
        translateUi(
          "workspace.editor.workspaceSymbols.invalidLocation",
          "Could not open the symbol location.",
        ),
      );
      return;
    }
    onOpenChange(false);
  } catch (err) {
    toast.error(
      translateUi(
        "workspace.editor.workspaceSymbols.openFailed",
        "Failed to open symbol: {{error}}",
        { error: apiErrorMessage(err, String(err)) },
      ),
    );
  }
}
