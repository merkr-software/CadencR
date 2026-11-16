/**
 * CSV / TSV as a read-only spreadsheet grid, columns sized to their content.
 * Mounted by the Preview tab (from the file's bytes) and by the Editor's
 * preview toggle (from the live buffer text).
 */
import { memo, useCallback, type ReactElement } from "react";
import { DocumentError, DocumentLoading, DocumentStatusBar } from "../DocumentChrome";
import { fitColumnWidths, measureGridText } from "./column-widths";
import { SheetGrid } from "./SheetGrid";
import { sheetSummary } from "./sheet";
import { useLoadable } from "../useLoadable";
import { decodeText, DELIMITER_LABELS, delimiterForPath, parseDelimited } from "./parse-csv";

interface CsvTableProps {
  /** Raw file bytes (decoded here) or already-decoded text. */
  source: ArrayBuffer | string;
  fileName: string;
}

export const CsvTable = memo(function CsvTable({ source, fileName }: CsvTableProps): ReactElement {
  // Async so a decoding failure becomes a rejection the loader shows inline.
  const load = useCallback(async () => {
    const text = typeof source === "string" ? source : decodeText(source);
    return fitColumnWidths(parseDelimited(text, delimiterForPath(fileName)), measureGridText());
  }, [fileName, source]);
  const sheet = useLoadable(load, "Could not read CSV file");

  let body: ReactElement;
  if (sheet.status === "error") body = <DocumentError message={sheet.message} />;
  else if (sheet.status === "loading") body = <DocumentLoading label="Reading table…" />;
  else if (sheet.value.rowCount === 0) {
    body = (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        This file is empty
      </div>
    );
  } else body = <SheetGrid sheet={sheet.value} />;

  const status =
    sheet.status === "ready"
      ? `${fileName} · ${sheetSummary(sheet.value)} · ${DELIMITER_LABELS[sheet.value.delimiter]}`
      : fileName;
  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col bg-background">{body}</div>
      <DocumentStatusBar status={status} />
    </>
  );
});
