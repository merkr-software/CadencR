//! The workbook's ZIP container: which sheet parts to read, whether the
//! workbook asks for a full recalculation, and rewriting changed sheets.

use std::collections::HashMap;
use std::io::{Cursor, Read, Write};

use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

/// Decompressed size a recalculation may load: sheet XML expands well past
/// the 50 MB file cap, and the engine holds all of it in memory at once.
pub(super) const MAX_UNCOMPRESSED_BYTES: u64 = 256 * 1024 * 1024;
const WORKBOOK_PART: &str = "xl/workbook.xml";
const WORKBOOK_RELS_PART: &str = "xl/_rels/workbook.xml.rels";
const RELATIONSHIPS_NS: &str =
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

pub(super) type Archive<'a> = ZipArchive<Cursor<&'a [u8]>>;

/// A worksheet, in workbook order — the same order the engine numbers them.
pub(super) struct SheetPart {
    pub name: String,
    pub path: String,
}

pub(super) struct WorkbookInfo {
    pub sheets: Vec<SheetPart>,
    /// `<calcPr fullCalcOnLoad="1">`: the saved results are placeholders
    /// (xlsxwriter stores 0 for every formula) and Excel recomputes on open.
    pub full_calc_on_load: bool,
}

pub(super) fn open(bytes: &[u8]) -> Result<Archive<'_>, String> {
    ZipArchive::new(Cursor::new(bytes))
        .map_err(|_| "This workbook isn't a valid ZIP archive".into())
}

/// Refuse a workbook whose entries declare more than the engine may load.
/// The engine unzips on its own, so declared sizes are all that bounds it.
pub(super) fn check_declared_size(archive: &mut Archive<'_>) -> Result<(), String> {
    let mut total: u64 = 0;
    for index in 0..archive.len() {
        let entry = archive
            .by_index_raw(index)
            .map_err(|e| format!("Unreadable workbook entry: {e}"))?;
        total = total.saturating_add(entry.size());
    }
    if total > MAX_UNCOMPRESSED_BYTES {
        return Err("This workbook is too large to recalculate".into());
    }
    Ok(())
}

/// Read a part as text, charging its real decompressed size to `budget` —
/// a lying size header can't make it read more.
pub(super) fn read_text(
    archive: &mut Archive<'_>,
    path: &str,
    budget: &mut u64,
) -> Result<String, String> {
    let entry = archive
        .by_name(path)
        .map_err(|_| format!("The workbook has no {path} part"))?;
    let mut text = String::new();
    entry
        .take(*budget + 1)
        .read_to_string(&mut text)
        .map_err(|e| format!("Unreadable workbook part {path}: {e}"))?;
    *budget = budget
        .checked_sub(text.len() as u64)
        .ok_or("This workbook is too large to recalculate")?;
    Ok(text)
}

fn parse<'a>(xml: &'a str, part: &str) -> Result<roxmltree::Document<'a>, String> {
    roxmltree::Document::parse(xml).map_err(|e| format!("Malformed workbook part {part}: {e}"))
}

pub(super) fn workbook_info(archive: &mut Archive<'_>) -> Result<WorkbookInfo, String> {
    let rels_xml = read_text(
        archive,
        WORKBOOK_RELS_PART,
        &mut MAX_UNCOMPRESSED_BYTES.clone(),
    )?;
    let rels = parse(&rels_xml, WORKBOOK_RELS_PART)?;
    let worksheet_targets: HashMap<&str, &str> = rels
        .descendants()
        .filter(|node| node.has_tag_name("Relationship"))
        .filter(|node| {
            node.attribute("Type")
                .is_some_and(|kind| kind.ends_with("/worksheet"))
        })
        .filter_map(|node| Some((node.attribute("Id")?, node.attribute("Target")?)))
        .collect();

    let workbook_xml = read_text(archive, WORKBOOK_PART, &mut MAX_UNCOMPRESSED_BYTES.clone())?;
    let workbook = parse(&workbook_xml, WORKBOOK_PART)?;
    let sheets = workbook
        .descendants()
        .filter(|node| node.has_tag_name("sheet"))
        .filter_map(|node| {
            let target = worksheet_targets.get(node.attribute((RELATIONSHIPS_NS, "id"))?)?;
            Some(SheetPart {
                name: node.attribute("name")?.to_string(),
                path: part_path(target),
            })
        })
        .collect();
    let full_calc_on_load = workbook
        .descendants()
        .find(|node| node.has_tag_name("calcPr"))
        .and_then(|node| node.attribute("fullCalcOnLoad"))
        .is_some_and(|value| value == "1" || value == "true");
    Ok(WorkbookInfo {
        sheets,
        full_calc_on_load,
    })
}

/// A relationship target as a part name — resolved the way the engine
/// resolves it, so both sides read the same sheet.
fn part_path(target: &str) -> String {
    match target.strip_prefix('/') {
        Some(absolute) => absolute.to_string(),
        None => format!("xl/{target}"),
    }
}

/// The archive with `replaced` parts swapped in; every other entry is copied
/// byte for byte, still compressed.
pub(super) fn rewrite(
    archive: &mut Archive<'_>,
    replaced: &HashMap<String, String>,
) -> Result<Vec<u8>, String> {
    let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    for index in 0..archive.len() {
        let entry = archive
            .by_index_raw(index)
            .map_err(|e| format!("Unreadable workbook entry: {e}"))?;
        let write_error = |e: &dyn std::fmt::Display| format!("Couldn't rebuild the workbook: {e}");
        let name = entry
            .name()
            .map_err(|e| format!("Unreadable workbook entry name: {e}"))?
            .into_owned();
        match replaced.get(&name) {
            Some(xml) => {
                drop(entry);
                writer
                    .start_file(name, options)
                    .map_err(|e| write_error(&e))?;
                writer
                    .write_all(xml.as_bytes())
                    .map_err(|e| write_error(&e))?;
            }
            None => writer.raw_copy_file(entry).map_err(|e| write_error(&e))?,
        }
    }
    let cursor = writer
        .finish()
        .map_err(|e| format!("Couldn't rebuild the workbook: {e}"))?;
    Ok(cursor.into_inner())
}
