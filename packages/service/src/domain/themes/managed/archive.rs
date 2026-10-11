//! Closed declarative archive admission: no links, directories, or executable data.
use std::path::Path;

use crate::error::AppError;

pub const MAX_ARCHIVE_BYTES: usize = 20 * 1024 * 1024;

pub fn extract(bytes: &[u8], destination: &Path) -> Result<(), AppError> {
    if bytes.len() > MAX_ARCHIVE_BYTES {
        return Err(invalid("theme archive exceeds byte budget"));
    }
    let files = cadencr_registry_core::read_theme_archive_bytes(bytes).map_err(invalid)?;
    crate::remote::secure_fs::create_dir_owner_only(destination).map_err(invalid)?;
    for (name, bytes) in files {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt as _;
            options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
        }
        let mut file = options.open(destination.join(name)).map_err(invalid)?;
        std::io::Write::write_all(&mut file, &bytes).map_err(invalid)?;
        file.sync_all().map_err(invalid)?;
    }
    Ok(())
}

pub fn invalid(message: impl std::fmt::Display) -> AppError {
    AppError::coded(
        axum::http::StatusCode::BAD_REQUEST,
        "MANAGED_THEME_INVALID",
        message.to_string(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    fn archive(name: &str, mode: u32, kind: tar::EntryType) -> Vec<u8> {
        let encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        let mut builder = tar::Builder::new(encoder);
        let mut header = tar::Header::new_gnu();
        header.set_size(2);
        header.set_mode(mode);
        header.set_entry_type(kind);
        header.set_cksum();
        builder.append_data(&mut header, name, &b"{}"[..]).unwrap();
        builder.into_inner().unwrap().finish().unwrap()
    }
    #[test]
    fn rejects_links_scripts_executable_permissions_and_invalid_document() {
        for (name, mode, kind) in [
            ("theme.json", 0o755, tar::EntryType::Regular),
            ("theme.json", 0o644, tar::EntryType::Symlink),
            ("script.js", 0o644, tar::EntryType::Regular),
            ("theme.json", 0o644, tar::EntryType::Regular),
            ("nested/theme.json", 0o644, tar::EntryType::Regular),
        ] {
            let root = tempfile::tempdir().unwrap();
            assert!(extract(&archive(name, mode, kind), &root.path().join("payload")).is_err());
            assert!(!root.path().join("payload").exists());
        }
    }
}
