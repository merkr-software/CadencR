import { useUiTranslation, type UiTranslator } from "@/lib/i18n/ui";
/**
 * CSV / TSV as a read-only spreadsheet grid, columns sized to their content.
 * Mounted by the Preview tab (from the file's bytes) and by the Editor's
 * preview toggle (from the live buffer text).
 */
import { memo, useCallback, type ReactElement } from "react";
import {
  documentErrorMessage,
  DocumentError,
  DocumentLoading,
  DocumentStatusBar,
} from "../DocumentChrome";
import { fitColumnWidths, measureGridText } from "./column-widths";
import { SheetGrid } from "./SheetGrid";
import { sheetSummary } from "./sheet";
import { useLoadable } from "../useLoadable";
import { decodeText, delimiterForPath, parseDelimited, type Delimiter } from "./parse-csv";

interface CsvTableProps {
  /** Raw file bytes (decoded here) or already-decoded text. */
  source: ArrayBuffer | string;
  fileName: string;
}

export const CsvTable = memo(function CsvTable({ source, fileName }: CsvTableProps): ReactElement {
  const { t } = useUiTranslation();
  // Async so a decoding failure becomes a rejection the loader shows inline.
  const load = useCallback(async () => {
    const text = typeof source === "string" ? source : decodeText(source);
    return fitColumnWidths(parseDelimited(text, delimiterForPath(fileName)), measureGridText());
  }, [fileName, source]);
  const sheet = useLoadable(load);

  let body: ReactElement;
  if (sheet.status === "error")
    body = (
      <DocumentError
        message={documentErrorMessage(
          sheet.error,
          t("workspace.editor.csvTable.readFailed", "Could not read CSV file"),
        )}
      />
    );
  else if (sheet.status === "loading")
    body = (
      <DocumentLoading label={t("workspace.editor.csvTable.readingTable", "Reading table…")} />
    );
  else if (sheet.value.rowCount === 0) {
    body = (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        {t("workspace.editor.csvTable.thisFileIsEmpty", "This file is empty")}
      </div>
    );
  } else body = <SheetGrid sheet={sheet.value} />;

  const status =
    sheet.status === "ready"
      ? t("workspace.editor.csvTable.summary", "{{file}} · {{size}} · {{delimiter}}", {
          file: fileName,
          size: sheetSummary(sheet.value, t),
          delimiter: delimiterLabel(sheet.value.delimiter, t),
        })
      : fileName;
  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col bg-background">{body}</div>
      <DocumentStatusBar status={status} />
    </>
  );
});

function delimiterLabel(delimiter: Delimiter, t: UiTranslator): string {
  switch (delimiter) {
    case ",":
      return t("workspace.editor.csvTable.commaSeparated", "comma-separated");
    case ";":
      return t("workspace.editor.csvTable.semicolonSeparated", "semicolon-separated");
    case "\t":
      return t("workspace.editor.csvTable.tabSeparated", "tab-separated");
    case "|":
      return t("workspace.editor.csvTable.pipeSeparated", "pipe-separated");
  }
}
