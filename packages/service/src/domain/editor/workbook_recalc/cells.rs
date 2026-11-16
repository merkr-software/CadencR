//! Formula cells in a worksheet's XML, and rewriting one with a computed
//! result. Edits are byte splices into the original text, so every other
//! cell, attribute and extension element stays exactly as the file had it.

use std::ops::Range;

/// One formula cell (`<c>` with an `<f>` child), located in the sheet XML.
pub(super) struct FormulaCell {
    /// 1-based, like the engine's coordinates.
    pub row: i32,
    pub column: i32,
    /// Whether the file saved a result next to the formula (non-empty `<v>`).
    pub cached: bool,
    span: Range<usize>,
    /// End of the start tag (just past its `>`).
    start_tag_end: usize,
    /// The `t="…"` attribute, with its leading whitespace.
    type_attr: Option<Range<usize>>,
    formula_end: usize,
    /// `<v>` / `<is>` children the new value replaces.
    stale_values: Vec<Range<usize>>,
    /// Namespace prefix the element is written with (`x:` in OpenXML SDK output).
    prefix: String,
}

/// A computed result, typed the way a `<c>` element stores it.
pub(super) enum CellResult {
    Number(f64),
    Text(String),
    Boolean(bool),
    /// An Excel error literal: `#DIV/0!`, `#N/A`, …
    Error(String),
}

pub(super) fn formula_cells(xml: &str, part: &str) -> Result<Vec<FormulaCell>, String> {
    let document =
        roxmltree::Document::parse(xml).map_err(|e| format!("Malformed worksheet {part}: {e}"))?;
    let mut cells = Vec::new();
    let mut row_number = 0;
    for row in document
        .descendants()
        .filter(|node| node.has_tag_name("row"))
    {
        // `r` is optional: a row without one follows the previous row.
        row_number = row
            .attribute("r")
            .and_then(|value| value.parse().ok())
            .unwrap_or(row_number + 1);
        let mut column_number = 0;
        for cell in row.children().filter(|node| node.has_tag_name("c")) {
            // A cell's own `r` wins; without one it follows the previous cell.
            let (column, row) = cell
                .attribute("r")
                .and_then(parse_reference)
                .unwrap_or((column_number + 1, row_number));
            column_number = column;
            if let Some(found) = formula_cell(xml, cell, row, column) {
                cells.push(found);
            }
        }
    }
    Ok(cells)
}

fn formula_cell(
    xml: &str,
    cell: roxmltree::Node<'_, '_>,
    row: i32,
    column: i32,
) -> Option<FormulaCell> {
    let formula = cell.children().find(|node| node.has_tag_name("f"))?;
    let span = cell.range();
    let start_tag_end = cell.first_child()?.range().start;
    let values: Vec<_> = cell
        .children()
        .filter(|node| node.has_tag_name("v") || node.has_tag_name("is"))
        .collect();
    let cached = values
        .iter()
        .any(|node| node.has_tag_name("v") && node.text().is_some_and(|text| !text.is_empty()));
    let type_attr = cell
        .attributes()
        .find(|attr| attr.name() == "t" && attr.namespace().is_none())
        .map(|attr| attribute_span(xml, attr.position()));
    let qualified_name = xml[span.start + 1..start_tag_end]
        .split(|ch: char| ch.is_whitespace() || ch == '>' || ch == '/')
        .next()
        .unwrap_or("c");
    let prefix = qualified_name
        .rsplit_once(':')
        .map(|(prefix, _)| format!("{prefix}:"))
        .unwrap_or_default();
    Some(FormulaCell {
        row,
        column,
        cached,
        span,
        start_tag_end,
        type_attr,
        formula_end: formula.range().end,
        stale_values: values.iter().map(|node| node.range()).collect(),
        prefix,
    })
}

/// `"AB12"` → (column 28, row 12). `None` for anything that isn't an A1 reference.
fn parse_reference(reference: &str) -> Option<(i32, i32)> {
    let digits = reference.find(|ch: char| ch.is_ascii_digit())?;
    let (letters, row) = reference.split_at(digits);
    let column = letters.bytes().try_fold(0i32, |column, byte| {
        if !byte.is_ascii_alphabetic() {
            return None;
        }
        column
            .checked_mul(26)?
            .checked_add(i32::from(byte.to_ascii_uppercase() - b'A' + 1))
    })?;
    let row = row.parse().ok()?;
    (column > 0 && row > 0).then_some((column, row))
}

/// The span of the attribute starting at `name_start`, plus the whitespace
/// before it. XML forbids the delimiting quote inside the value, so the
/// next one closes it.
fn attribute_span(xml: &str, name_start: usize) -> Range<usize> {
    let before = xml[..name_start].trim_end().len();
    let rest = &xml[name_start..];
    let end = rest
        .find(['"', '\''])
        .and_then(|open| {
            let quote = rest.as_bytes()[open] as char;
            rest[open + 1..]
                .find(quote)
                .map(|close| open + 1 + close + 1)
        })
        .map_or(xml.len(), |len| name_start + len);
    before..end
}

impl FormulaCell {
    /// The splice that gives this cell `result`: its byte span in the sheet
    /// XML and the replacement element.
    pub fn patch(&self, xml: &str, result: &CellResult) -> (Range<usize>, String) {
        let (type_value, text) = match result {
            CellResult::Number(number) => (None, number.to_string()),
            CellResult::Text(text) => (Some("str"), escape_text(text)),
            CellResult::Boolean(value) => (Some("b"), u8::from(*value).to_string()),
            CellResult::Error(literal) => (Some("e"), escape_text(literal)),
        };
        let mut element = String::with_capacity(self.span.len() + text.len() + 16);
        let start_tag = &xml[self.span.start..self.start_tag_end];
        match &self.type_attr {
            Some(attr) => {
                element.push_str(&xml[self.span.start..attr.start]);
                element.push_str(&xml[attr.end..self.start_tag_end - 1]);
            }
            None => element.push_str(&start_tag[..start_tag.len() - 1]),
        }
        if let Some(kind) = type_value {
            element.push_str(&format!(" t=\"{kind}\""));
        }
        element.push('>');
        element.push_str(&xml[self.start_tag_end..self.formula_end]);
        let prefix = &self.prefix;
        element.push_str(&format!("<{prefix}v>{text}</{prefix}v>"));
        let mut cursor = self.formula_end;
        for stale in &self.stale_values {
            if stale.start < cursor {
                continue;
            }
            element.push_str(&xml[cursor..stale.start]);
            cursor = stale.end;
        }
        element.push_str(&xml[cursor..self.span.end]);
        (self.span.clone(), element)
    }
}

fn escape_text(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// `xml` with every splice applied. Splices must not overlap.
pub(super) fn apply_patches(xml: &str, mut patches: Vec<(Range<usize>, String)>) -> String {
    patches.sort_by_key(|(range, _)| range.start);
    let mut out = String::with_capacity(xml.len() + patches.len() * 24);
    let mut cursor = 0;
    for (range, replacement) in patches {
        out.push_str(&xml[cursor..range.start]);
        out.push_str(&replacement);
        cursor = range.end;
    }
    out.push_str(&xml[cursor..]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const NS: &str = r#"xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main""#;

    fn sheet(rows: &str) -> String {
        format!("<worksheet {NS}><sheetData>{rows}</sheetData></worksheet>")
    }

    fn patched(xml: &str, result: CellResult) -> String {
        let cells = formula_cells(xml, "sheet1.xml").unwrap();
        let patches = cells.iter().map(|cell| cell.patch(xml, &result)).collect();
        apply_patches(xml, patches)
    }

    #[test]
    fn finds_formula_cells_and_whether_they_saved_a_result() {
        let xml = sheet(
            r#"<row r="2"><c r="B2" t="n"><v>4</v></c><c r="D2"><f>SUM(B2:C2)</f><v /></c></row>
               <row r="3"><c r="AA3"><f>1+1</f><v>2</v></c></row>"#,
        );
        let cells = formula_cells(&xml, "sheet1.xml").unwrap();
        let found: Vec<_> = cells.iter().map(|c| (c.row, c.column, c.cached)).collect();
        assert_eq!(found, vec![(2, 4, false), (3, 27, true)]);
    }

    #[test]
    fn infers_positions_when_references_are_omitted() {
        let xml =
            sheet(r#"<row><c><v>1</v></c><c><f>A1*2</f></c></row><row><c><f>A1</f></c></row>"#);
        let cells = formula_cells(&xml, "sheet1.xml").unwrap();
        let found: Vec<_> = cells.iter().map(|c| (c.row, c.column)).collect();
        assert_eq!(found, vec![(1, 2), (2, 1)]);
    }

    #[test]
    fn reads_the_row_from_the_cell_reference_when_the_row_has_none() {
        let xml = sheet(r#"<row><c r="C5"><f>1+1</f></c></row>"#);
        let cells = formula_cells(&xml, "sheet1.xml").unwrap();
        assert_eq!((cells[0].row, cells[0].column), (5, 3));
    }

    #[test]
    fn writes_a_number_replacing_the_empty_placeholder() {
        let xml = sheet(r#"<row r="1"><c r="A1" s="3"><f>SUM(B1:C1)</f><v /></c></row>"#);
        assert_eq!(
            patched(&xml, CellResult::Number(377500.0)),
            sheet(r#"<row r="1"><c r="A1" s="3"><f>SUM(B1:C1)</f><v>377500</v></c></row>"#)
        );
    }

    #[test]
    fn retypes_the_cell_for_text_booleans_and_errors() {
        let xml = sheet(r#"<row r="1"><c r="A1" t="n" s="1"><f>A2&amp;"x"</f><v>0</v></c></row>"#);
        assert_eq!(
            patched(&xml, CellResult::Text("a<b & c".into())),
            sheet(
                r#"<row r="1"><c r="A1" s="1" t="str"><f>A2&amp;"x"</f><v>a&lt;b &amp; c</v></c></row>"#
            )
        );
        let xml = sheet(r#"<row r="1"><c r="A1"><f>1&gt;0</f></c></row>"#);
        assert_eq!(
            patched(&xml, CellResult::Boolean(true)),
            sheet(r#"<row r="1"><c r="A1" t="b"><f>1&gt;0</f><v>1</v></c></row>"#)
        );
        assert_eq!(
            patched(&xml, CellResult::Error("#DIV/0!".into())),
            sheet(r#"<row r="1"><c r="A1" t="e"><f>1&gt;0</f><v>#DIV/0!</v></c></row>"#)
        );
    }

    #[test]
    fn keeps_the_namespace_prefix_and_trailing_children() {
        let xml = (
            r#"<x:worksheet xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><x:sheetData><x:row r="1"><x:c r="A1"><x:f>1+1</x:f><x:v></x:v><x:extLst/></x:c></x:row></x:sheetData></x:worksheet>"#
        )
            .to_string();
        let out = patched(&xml, CellResult::Number(2.0));
        assert!(
            out.contains(r#"<x:c r="A1"><x:f>1+1</x:f><x:v>2</x:v><x:extLst/></x:c>"#),
            "{out}"
        );
    }

    #[test]
    fn rejects_malformed_xml() {
        assert!(formula_cells("<worksheet><row>", "sheet1.xml").is_err());
    }
}
