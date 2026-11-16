import type { FormulaRecalc } from "@/lib/document-file";

export interface DocumentRendererProps {
  /**
   * Raw file bytes. Shared with the React Query cache: renderers must never
   * hand this buffer to an API that transfers or detaches it (pdf.js does) —
   * copy it first.
   */
  data: ArrayBuffer;
  /** Workbooks only: formula results the service computed, if it had to. */
  formulas: FormulaRecalc | null;
  fileName: string;
}
