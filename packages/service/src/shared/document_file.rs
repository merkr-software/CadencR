use std::path::Path;

/// Maximum office document / PDF payload the editor preview route serves.
/// Larger than the image cap: slide decks with embedded media routinely pass
/// 25 MB. The bytes are parsed client-side; the service only loads a workbook
/// whose formula results it has to compute (`editor::workbook_recalc`).
pub const MAX_DOCUMENT_FILE_SIZE: usize = 50 * 1024 * 1024;

pub const XLSX_MIME: &str = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/// Return the MIME type for a document format the desktop preview renders:
/// PDF, the OOXML Office formats, and CSV / TSV (shown as a table).
///
/// The desktop frontend's `getDocumentKind` helper must stay in lockstep with
/// this allowlist.
pub fn document_mime_for_path(path: &Path) -> Option<&'static str> {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();

    match extension.as_str() {
        "pdf" => Some("application/pdf"),
        "docx" => Some("application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
        "xlsx" => Some(XLSX_MIME),
        "pptx" => Some("application/vnd.openxmlformats-officedocument.presentationml.presentation"),
        "csv" => Some("text/csv"),
        "tsv" => Some("text/tab-separated-values"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_supported_extensions_case_insensitively() {
        assert_eq!(
            document_mime_for_path(Path::new("report.PDF")),
            Some("application/pdf")
        );
        assert!(document_mime_for_path(Path::new("a/b.docx")).is_some());
        assert!(document_mime_for_path(Path::new("sheet.xlsx")).is_some());
        assert!(document_mime_for_path(Path::new("deck.pptx")).is_some());
        assert_eq!(
            document_mime_for_path(Path::new("data/export.CSV")),
            Some("text/csv")
        );
        assert_eq!(
            document_mime_for_path(Path::new("export.tsv")),
            Some("text/tab-separated-values")
        );
    }

    #[test]
    fn rejects_legacy_binary_and_unknown_formats() {
        assert_eq!(document_mime_for_path(Path::new("old.doc")), None);
        assert_eq!(document_mime_for_path(Path::new("old.xls")), None);
        assert_eq!(document_mime_for_path(Path::new("notes.txt")), None);
        assert_eq!(document_mime_for_path(Path::new("pdf")), None);
    }
}
