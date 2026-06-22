/**
 * Find-references results panel. Opened by Shift+F12. Reuses the cross-file
 * search-results layout convention (grouped-by-file rows in a dialog) and
 * virtualizes the row list with `react-virtuoso` because references can run
 * into the hundreds. Selecting a row jumps to that location via the shared
 * `openLspLocation` helper (same navigation path as go-to-definition).
 */
import { memo, useMemo } from "react";
import type { EditorView } from "@codemirror/view";
import { Virtuoso } from "react-virtuoso";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { FileSymbolIcon } from "../file-icons";
import { openLspLocation, type LspLocation } from "@/lib/lsp/lsp-position";
import { fileUriToPath } from "@/lib/lsp/file-uri";

interface EditorReferencesPanelProps {
  view: EditorView;
  references: LspLocation[];
  /** Absolute workspace root, for trimming display paths. May be null. */
  workspaceRoot: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type Row =
  | { type: "file"; path: string; count: number }
  | { type: "ref"; path: string; line: number; location: LspLocation };

/** Build display path relative to the workspace root when possible. */
function displayPath(uri: string, root: string | null): string {
  const abs = fileUriToPath(uri) ?? uri;
  if (root && abs.startsWith(root)) {
    return abs.slice(root.replace(/\/$/, "").length + 1);
  }
  return abs;
}

/** Flatten locations into file-header + reference rows, grouped by file. */
function buildRows(references: LspLocation[], root: string | null): Row[] {
  const byPath = new Map<string, LspLocation[]>();
  for (const loc of references) {
    const path = displayPath(loc.uri, root);
    const arr = byPath.get(path);
    if (arr) arr.push(loc);
    else byPath.set(path, [loc]);
  }
  const rows: Row[] = [];
  for (const [path, locs] of byPath) {
    rows.push({ type: "file", path, count: locs.length });
    for (const loc of locs) {
      rows.push({ type: "ref", path, line: loc.range.start.line + 1, location: loc });
    }
  }
  return rows;
}

function EditorReferencesPanel({
  view,
  references,
  workspaceRoot,
  open,
  onOpenChange,
}: EditorReferencesPanelProps) {
  const rows = useMemo(() => buildRows(references, workspaceRoot), [references, workspaceRoot]);
  const fileCount = useMemo(() => rows.filter((r) => r.type === "file").length, [rows]);

  const handleJump = async (location: LspLocation): Promise<void> => {
    try {
      const target = await openLspLocation(view, location);
      if (!target) {
        toast.error("Could not open the reference location.");
        return;
      }
      onOpenChange(false);
    } catch (err) {
      toast.error(`Failed to open reference: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="sm:max-w-[760px] h-[70vh] !flex !flex-col gap-0 p-0 pt-3 overflow-hidden"
      >
        <DialogHeader className="px-3 pb-2 border-b border-border">
          <DialogTitle className="text-sm font-medium">
            {references.length} reference{references.length === 1 ? "" : "s"} in {fileCount} file
            {fileCount === 1 ? "" : "s"}
          </DialogTitle>
        </DialogHeader>
        {rows.length === 0 ? (
          <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
            No references found.
          </div>
        ) : (
          <Virtuoso
            className="flex-1 min-h-0"
            data={rows}
            itemContent={(_index, row) =>
              row.type === "file" ? (
                <FileHeaderRow path={row.path} count={row.count} />
              ) : (
                <RefRow row={row} onJump={handleJump} />
              )
            }
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function FileHeaderRow({ path, count }: { path: string; count: number }) {
  const fileName = path.split("/").pop() ?? path;
  return (
    <div className="flex items-center gap-1.5 px-3 py-1 text-xs font-medium text-foreground bg-muted/40">
      <FileSymbolIcon fileName={fileName} className="shrink-0 flex items-center" />
      <span className="truncate">{path}</span>
      <span className="ml-auto text-muted-foreground shrink-0">{count}</span>
    </div>
  );
}

function RefRow({
  row,
  onJump,
}: {
  row: Extract<Row, { type: "ref" }>;
  onJump: (location: LspLocation) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onJump(row.location)}
      className="flex w-full items-center gap-2 px-3 py-1 pl-8 text-left text-xs hover:bg-accent transition-colors"
    >
      <span className="text-muted-foreground tabular-nums shrink-0">{row.line}</span>
      <span className="truncate text-muted-foreground">{row.path.split("/").pop()}</span>
    </button>
  );
}

export default memo(EditorReferencesPanel);
