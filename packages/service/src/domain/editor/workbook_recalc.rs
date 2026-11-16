//! Formula results for workbooks saved without them.
//!
//! Excel, Sheets, Numbers and LibreOffice save each formula's last result
//! (`<v>`) next to it, and the preview shows those. Workbooks written by
//! scripts — openpyxl, xlsxwriter, exceljs, i.e. what agents produce — save
//! the formula alone, or a placeholder flagged `fullCalcOnLoad`; Excel
//! recomputes them on open, a viewer shows blanks or zeros. For those,
//! IronCalc evaluates the workbook and its results are spliced into the
//! original sheet XML: only formula cells' values change, so styles, charts
//! and everything else IronCalc doesn't model reach the viewer untouched.
//! Workbooks that already carry their results are never recomputed.

mod archive;
mod cells;
mod engine;

use std::collections::HashMap;

/// Beyond this, evaluation would hold the request for seconds.
const MAX_FORMULAS: usize = 250_000;

/// What the preview should tell the reader about a workbook's formula values.
#[derive(Debug, PartialEq)]
pub enum FormulaSummary {
    Computed {
        /// Formulas whose result IronCalc wrote in.
        computed: usize,
        /// Formulas IronCalc couldn't compute (unsupported function or
        /// syntax); they keep whatever the file saved, usually nothing.
        unresolved: usize,
    },
    /// The workbook needed recalculating and couldn't be; it's served as saved.
    Failed { reason: String },
}

struct SheetFormulas {
    path: String,
    xml: String,
    cells: Vec<cells::FormulaCell>,
}

/// The workbook to show, plus a summary when its formula results came from
/// IronCalc (or should have). `None`: it carried its own, served untouched.
pub fn recalculate_workbook(bytes: Vec<u8>) -> (Vec<u8>, Option<FormulaSummary>) {
    match recalculate(&bytes) {
        Ok(None) => (bytes, None),
        Ok(Some((patched, summary))) => (patched.unwrap_or(bytes), Some(summary)),
        Err(reason) => (bytes, Some(FormulaSummary::Failed { reason })),
    }
}

/// The rewritten workbook (`None` when no result could be written) and its summary.
type Recalculated = (Option<Vec<u8>>, FormulaSummary);

fn recalculate(bytes: &[u8]) -> Result<Option<Recalculated>, String> {
    let mut archive = archive::open(bytes)?;
    let workbook = archive::workbook_info(&mut archive)?;
    if !needs_recalculation(&mut archive, &workbook)? {
        return Ok(None);
    }

    archive::check_declared_size(&mut archive)?;
    let mut budget = archive::MAX_UNCOMPRESSED_BYTES;
    let mut sheets = Vec::with_capacity(workbook.sheets.len());
    for part in &workbook.sheets {
        let xml = archive::read_text(&mut archive, &part.path, &mut budget)?;
        let cells = cells::formula_cells(&xml, &part.path)?;
        sheets.push(SheetFormulas {
            path: part.path.clone(),
            xml,
            cells,
        });
    }
    if sheets.iter().map(|sheet| sheet.cells.len()).sum::<usize>() > MAX_FORMULAS {
        return Err("This workbook has too many formulas to recalculate".into());
    }

    let evaluated = engine::evaluate(bytes, &workbook.sheets)?;
    let (mut computed, mut unresolved) = (0, 0);
    let mut replaced = HashMap::new();
    for (index, sheet) in sheets.iter().enumerate() {
        let sheet_index = u32::try_from(index).map_err(|_| "Too many sheets")?;
        let mut patches = Vec::new();
        // With `fullCalcOnLoad`, saved results are placeholders: replace them all.
        let targets = sheet
            .cells
            .iter()
            .filter(|cell| workbook.full_calc_on_load || !cell.cached);
        for cell in targets {
            match evaluated.result(sheet_index, cell.row, cell.column) {
                Some(result) => {
                    patches.push(cell.patch(&sheet.xml, &result));
                    computed += 1;
                }
                None => unresolved += 1,
            }
        }
        if !patches.is_empty() {
            replaced.insert(
                sheet.path.clone(),
                cells::apply_patches(&sheet.xml, patches),
            );
        }
    }
    let patched = if replaced.is_empty() {
        None
    } else {
        Some(archive::rewrite(&mut archive, &replaced)?)
    };
    let summary = FormulaSummary::Computed {
        computed,
        unresolved,
    };
    Ok(Some((patched, summary)))
}

/// Whether any formula lacks a trustworthy saved result. Reads one sheet at a
/// time, so the common case — a workbook Excel saved — holds one sheet's XML
/// at most and never meets the recalculation size limit.
fn needs_recalculation(
    archive: &mut archive::Archive<'_>,
    workbook: &archive::WorkbookInfo,
) -> Result<bool, String> {
    for part in &workbook.sheets {
        let mut budget = archive::MAX_UNCOMPRESSED_BYTES;
        let xml = archive::read_text(archive, &part.path, &mut budget)?;
        let cells = cells::formula_cells(&xml, &part.path)?;
        // `fullCalcOnLoad` makes every formula's saved result a placeholder.
        if cells
            .iter()
            .any(|cell| workbook.full_calc_on_load || !cell.cached)
        {
            return Ok(true);
        }
    }
    Ok(false)
}

#[cfg(test)]
mod tests {
    use std::io::{Cursor, Read, Write};

    use zip::write::SimpleFileOptions;
    use zip::{ZipArchive, ZipWriter};

    use super::*;

    const MAIN_NS: &str = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
    const STYLES: &str = r#"<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>"#;

    /// A one-sheet workbook ("Data") with `rows` as its sheet data.
    fn workbook(rows: &str, calc_pr: &str) -> Vec<u8> {
        workbook_with_styles(rows, calc_pr, STYLES)
    }

    fn workbook_with_styles(rows: &str, calc_pr: &str, styles: &str) -> Vec<u8> {
        let parts = [
            (
                "xl/workbook.xml",
                format!(
                    r#"<workbook xmlns="{MAIN_NS}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets>{calc_pr}</workbook>"#
                ),
            ),
            (
                "xl/_rels/workbook.xml.rels",
                r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>"#.to_string(),
            ),
            ("xl/styles.xml", styles.to_string()),
            (
                "xl/worksheets/sheet1.xml",
                format!(r#"<worksheet xmlns="{MAIN_NS}"><sheetData>{rows}</sheetData></worksheet>"#),
            ),
        ];
        let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
        for (name, text) in parts {
            writer
                .start_file(name, SimpleFileOptions::default())
                .unwrap();
            writer.write_all(text.as_bytes()).unwrap();
        }
        writer.finish().unwrap().into_inner()
    }

    fn part(bytes: &[u8], name: &str) -> String {
        let mut archive = ZipArchive::new(Cursor::new(bytes)).unwrap();
        let mut text = String::new();
        archive
            .by_name(name)
            .unwrap()
            .read_to_string(&mut text)
            .unwrap();
        text
    }

    const VALUES: &str = r#"<row r="1"><c r="A1"><v>182000</v></c><c r="B1"><v>195500</v></c>"#;

    fn computed(computed: usize, unresolved: usize) -> FormulaSummary {
        FormulaSummary::Computed {
            computed,
            unresolved,
        }
    }

    fn failed(reason: &str) -> Option<FormulaSummary> {
        Some(FormulaSummary::Failed {
            reason: reason.into(),
        })
    }

    #[test]
    fn writes_results_for_formulas_saved_without_one() {
        let rows = format!(
            r#"{VALUES}<c r="C1"><f>SUM(A1:B1)</f><v /></c><c r="D1"><f>IF(C1&gt;0,"up","down")</f></c></row>"#
        );
        let (bytes, summary) = recalculate_workbook(workbook(&rows, ""));
        assert_eq!(summary, Some(computed(2, 0)));
        let sheet = part(&bytes, "xl/worksheets/sheet1.xml");
        assert!(
            sheet.contains(r#"<c r="C1"><f>SUM(A1:B1)</f><v>377500</v></c>"#),
            "{sheet}"
        );
        assert!(
            sheet.contains(r#"<c r="D1" t="str"><f>IF(C1&gt;0,"up","down")</f><v>up</v></c>"#),
            "{sheet}"
        );
        assert_eq!(part(&bytes, "xl/styles.xml"), STYLES);
    }

    #[test]
    fn leaves_workbooks_with_saved_results_alone() {
        let rows = format!(r#"{VALUES}<c r="C1"><f>SUM(A1:B1)</f><v>1</v></c></row>"#);
        let original = workbook(&rows, "");
        assert_eq!(recalculate_workbook(original.clone()), (original, None));
    }

    #[test]
    fn leaves_formula_free_workbooks_alone_even_when_asked_to_recalculate() {
        // xlsxwriter flags every workbook `fullCalcOnLoad`, formulas or not.
        let original = workbook(
            &format!("{VALUES}</row>"),
            r#"<calcPr fullCalcOnLoad="1"/>"#,
        );
        assert_eq!(recalculate_workbook(original.clone()), (original, None));
    }

    #[test]
    fn replaces_placeholder_results_when_the_workbook_asks_for_a_full_recalculation() {
        let rows = format!(r#"{VALUES}<c r="C1"><f>SUM(A1:B1)</f><v>0</v></c></row>"#);
        let (bytes, summary) =
            recalculate_workbook(workbook(&rows, r#"<calcPr fullCalcOnLoad="1"/>"#));
        assert_eq!(summary, Some(computed(1, 0)));
        assert!(part(&bytes, "xl/worksheets/sheet1.xml").contains("<v>377500</v>"));
    }

    #[test]
    fn writes_excel_errors_but_not_what_the_engine_cannot_compute() {
        let rows = r#"<row r="1"><c r="A1"><f>1/0</f></c><c r="B1"><f>[1]Other!A1</f></c></row>"#;
        let (bytes, summary) = recalculate_workbook(workbook(rows, ""));
        assert_eq!(summary, Some(computed(1, 1)));
        let sheet = part(&bytes, "xl/worksheets/sheet1.xml");
        assert!(
            sheet.contains(r#"<c r="A1" t="e"><f>1/0</f><v>#DIV/0!</v></c>"#),
            "{sheet}"
        );
        assert!(
            sheet.contains(r#"<c r="B1"><f>[1]Other!A1</f></c>"#),
            "{sheet}"
        );
    }

    #[test]
    fn serves_the_workbook_untouched_when_nothing_could_be_computed() {
        let original = workbook(r#"<row r="1"><c r="A1"><f>[1]Other!A1</f></c></row>"#, "");
        let (bytes, summary) = recalculate_workbook(original.clone());
        assert_eq!((bytes, summary), (original, Some(computed(0, 1))));
    }

    #[test]
    fn reports_an_engine_crash_as_a_failure() {
        // Valid OOXML (`cellStyles` is optional) that IronCalc 0.8 indexes into.
        let styles = STYLES.replace(
            r#"<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>"#,
            "",
        );
        let rows = r#"<row r="1"><c r="A1"><f>1+1</f></c></row>"#;
        let original = workbook_with_styles(rows, "", &styles);
        assert_eq!(
            recalculate_workbook(original.clone()),
            (
                original,
                failed("The formula engine crashed on this workbook")
            )
        );
    }

    #[test]
    fn fails_with_a_reason_on_a_broken_workbook() {
        let (_, summary) = recalculate_workbook(b"not a zip".to_vec());
        assert_eq!(summary, failed("This workbook isn't a valid ZIP archive"));
    }
}
