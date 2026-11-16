/**
 * Read-only spreadsheet grid for CSV / TSV: Excel-style column letters and
 * row numbers, column widths from the sheet. Rows are virtualized (a file can
 * hold 100k of them); columns are bounded by `MAX_COLS`.
 */
import { memo, useMemo, type ComponentProps, type ReactElement } from "react";
import { TableVirtuoso, type TableComponents } from "react-virtuoso";
import { cn } from "@/lib/utils";
import { GRID_CELL_TEXT_CLASSES } from "./column-widths";
import { columnName, DEFAULT_COL_WIDTH_PX, type Sheet } from "./sheet";

const ROW_HEADER_WIDTH_PX = 52;
const ROW_HEIGHT_PX = 22;

const ColumnGroupTable = ({ style, ...props }: ComponentProps<"table">): ReactElement => (
  <table
    {...props}
    style={{ ...style, tableLayout: "fixed", borderCollapse: "separate", borderSpacing: 0 }}
    className="text-xs text-foreground"
  />
);

export const SheetGrid = memo(function SheetGrid({ sheet }: { sheet: Sheet }): ReactElement {
  const widths = useMemo(
    () =>
      Array.from(
        { length: sheet.colCount },
        (_, index) => sheet.colWidths[index] ?? DEFAULT_COL_WIDTH_PX,
      ),
    [sheet],
  );
  const totalWidth = ROW_HEADER_WIDTH_PX + widths.reduce((sum, width) => sum + width, 0);

  const components = useMemo<TableComponents>(
    () => ({
      Table: ({ children, ...props }) => (
        <ColumnGroupTable {...props} style={{ ...props.style, width: totalWidth }}>
          <colgroup>
            <col style={{ width: ROW_HEADER_WIDTH_PX }} />
            {widths.map((width, index) => (
              <col key={index} style={{ width }} />
            ))}
          </colgroup>
          {children}
        </ColumnGroupTable>
      ),
    }),
    [totalWidth, widths],
  );

  return (
    <TableVirtuoso
      className="min-h-0 flex-1"
      totalCount={sheet.rowCount}
      fixedItemHeight={ROW_HEIGHT_PX}
      increaseViewportBy={ROW_HEIGHT_PX * 10}
      components={components}
      fixedHeaderContent={() => (
        <tr>
          <th className="sticky left-0 z-20 border-b border-r border-border bg-muted" />
          {widths.map((_, index) => (
            <th
              key={index}
              scope="col"
              className="h-6 border-b border-r border-border bg-muted font-medium text-muted-foreground"
            >
              {columnName(index)}
            </th>
          ))}
        </tr>
      )}
      itemContent={(row) => <SheetRow sheet={sheet} row={row} />}
    />
  );
});

function SheetRow({ sheet, row }: { sheet: Sheet; row: number }): ReactElement {
  const cells = sheet.rows.get(row);
  const columns: ReactElement[] = [];
  for (let col = 0; col < sheet.colCount; col += 1) {
    const cell = cells?.get(col);
    columns.push(
      <td
        key={col}
        title={cell && cell.text.length > 24 ? cell.text : undefined}
        className={cn(
          GRID_CELL_TEXT_CLASSES,
          "truncate border-b border-r border-border/60 whitespace-nowrap",
          cell?.numeric && "text-right tabular-nums",
        )}
        style={{ height: ROW_HEIGHT_PX }}
      >
        {cell?.text}
      </td>,
    );
  }
  return (
    <>
      <th
        scope="row"
        className="sticky left-0 z-10 border-b border-r border-border bg-muted px-1 text-right font-normal tabular-nums text-muted-foreground"
      >
        {row + 1}
      </th>
      {columns}
    </>
  );
}
