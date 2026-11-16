/** CSV / TSV renderer for the document preview: a table over the file's bytes. */
import type { ReactElement } from "react";
import { CsvTable } from "./csv/CsvTable";
import type { DocumentRendererProps } from "./types";

export default function CsvDocumentView({ data, fileName }: DocumentRendererProps): ReactElement {
  return <CsvTable source={data} fileName={fileName} />;
}
