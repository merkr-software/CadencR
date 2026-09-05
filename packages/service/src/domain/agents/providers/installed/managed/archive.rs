//! Defensive extraction for digest-verified managed-provider artifacts.
use super::download::{ArtifactError, ArtifactErrorCode, VerifiedArtifact};
use std::collections::HashSet;
use std::fs::{File, OpenOptions};
use std::io::Read;
use std::path::{Path, PathBuf};

mod path_policy;
mod tar_extraction;
use path_policy::{
    create_directory, normalize_package_path, prepare_package_root, safe_file_mode,
    set_permissions, validate_mode,
};
use tar_extraction::extract_tar;
pub const MAX_ARCHIVE_ENTRIES: usize = 4_096;
pub const MAX_UNCOMPRESSED_BYTES: u64 = 512 * 1024 * 1024;
pub const MAX_SINGLE_FILE_BYTES: u64 = 256 * 1024 * 1024;
/// The result of extracting one verified artifact into an isolated package root.
#[derive(Debug, Clone)]
pub struct ExtractedPackage {
    package_root: PathBuf,
    executable: PathBuf,
    file_count: usize,
    uncompressed_bytes: u64,
}
impl ExtractedPackage {
    pub fn package_root(&self) -> &Path {
        &self.package_root
    }

    pub fn executable(&self) -> &Path {
        &self.executable
    }

    pub fn file_count(&self) -> usize {
        self.file_count
    }

    pub fn uncompressed_bytes(&self) -> u64 {
        self.uncompressed_bytes
    }
}
/// Extract only bytes that have already passed signed-index digest verification.
pub fn extract_verified(
    artifact: &VerifiedArtifact,
    package_root: &Path,
    executable: &str,
) -> Result<ExtractedPackage, ArtifactError> {
    let executable = normalize_package_path(Path::new(executable), "executable")?;
    if executable.as_os_str().is_empty() {
        return Err(ArtifactError::outside(
            "managed executable path must name a file",
        ));
    }
    prepare_package_root(package_root)?;
    let mut budget = ExtractionBudget::default();
    match archive_format(artifact.source_name())? {
        ArchiveFormat::Raw => extract_raw(artifact, package_root, &executable, &mut budget)?,
        ArchiveFormat::Zip => extract_zip(artifact.path(), package_root, &mut budget)?,
        ArchiveFormat::TarGzip => {
            let file = open_artifact(artifact.path())?;
            extract_tar(
                flate2::read::GzDecoder::new(file),
                package_root,
                &mut budget,
            )?;
        }
        ArchiveFormat::TarBzip2 => {
            let file = open_artifact(artifact.path())?;
            extract_tar(bzip2::read::BzDecoder::new(file), package_root, &mut budget)?;
        }
    }
    let executable = validate_executable(package_root, &executable)?;
    Ok(ExtractedPackage {
        package_root: package_root.to_path_buf(),
        executable,
        file_count: budget.file_count,
        uncompressed_bytes: budget.uncompressed_bytes,
    })
}
#[derive(Clone, Copy)]
enum ArchiveFormat {
    Raw,
    Zip,
    TarGzip,
    TarBzip2,
}
fn archive_format(source_name: &str) -> Result<ArchiveFormat, ArtifactError> {
    let path = source_name
        .split(['?', '#'])
        .next()
        .unwrap_or(source_name)
        .to_ascii_lowercase();
    if path.ends_with(".tar.gz") || path.ends_with(".tgz") {
        return Ok(ArchiveFormat::TarGzip);
    }
    if path.ends_with(".tar.bz2") || path.ends_with(".tbz2") {
        return Ok(ArchiveFormat::TarBzip2);
    }
    if path.ends_with(".zip") {
        return Ok(ArchiveFormat::Zip);
    }
    if [".tar", ".gz", ".bz2", ".xz", ".7z", ".rar"]
        .iter()
        .any(|suffix| path.ends_with(suffix))
    {
        return Err(ArtifactError::new(
            ArtifactErrorCode::UnsupportedArchive,
            format!("unsupported managed-provider archive format: {source_name}"),
        ));
    }
    Ok(ArchiveFormat::Raw)
}
#[derive(Default)]
struct ExtractionBudget {
    paths: HashSet<PathBuf>,
    entry_count: usize,
    file_count: usize,
    uncompressed_bytes: u64,
}
impl ExtractionBudget {
    fn register(&mut self, path: &Path, size: u64, is_file: bool) -> Result<(), ArtifactError> {
        self.entry_count = self.entry_count.saturating_add(1);
        if self.entry_count > MAX_ARCHIVE_ENTRIES {
            return Err(ArtifactError::new(
                ArtifactErrorCode::TooManyEntries,
                format!("archive exceeds {MAX_ARCHIVE_ENTRIES} entries"),
            ));
        }
        if !self.paths.insert(path.to_path_buf()) {
            return Err(ArtifactError::new(
                ArtifactErrorCode::DuplicatePath,
                format!("archive contains duplicate output path {}", path.display()),
            ));
        }
        if !is_file {
            return Ok(());
        }
        if size > MAX_SINGLE_FILE_BYTES {
            return Err(ArtifactError::new(
                ArtifactErrorCode::ArchiveTooLarge,
                format!(
                    "archive file {} is too large ({size} bytes)",
                    path.display()
                ),
            ));
        }
        self.uncompressed_bytes = self
            .uncompressed_bytes
            .checked_add(size)
            .ok_or_else(archive_too_large)?;
        if self.uncompressed_bytes > MAX_UNCOMPRESSED_BYTES {
            return Err(archive_too_large());
        }
        self.file_count += 1;
        Ok(())
    }
}

fn extract_raw(
    artifact: &VerifiedArtifact,
    root: &Path,
    executable: &Path,
    budget: &mut ExtractionBudget,
) -> Result<(), ArtifactError> {
    budget.register(executable, artifact.size(), true)?;
    let mut input = open_artifact(artifact.path())?;
    write_file(root, executable, &mut input, artifact.size(), 0o755)
}

fn extract_zip(
    artifact: &Path,
    root: &Path,
    budget: &mut ExtractionBudget,
) -> Result<(), ArtifactError> {
    let file = open_artifact(artifact)?;
    let mut archive = zip::ZipArchive::new(file).map_err(ArtifactError::unsafe_archive)?;
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(ArtifactError::unsafe_archive)?;
        let relative = normalize_package_path(Path::new(entry.name()), "archive entry")?;
        if relative.as_os_str().is_empty() {
            continue;
        }
        let is_dir = entry.is_dir();
        let size = entry.size();
        validate_mode(entry.unix_mode(), is_dir, &relative)?;
        budget.register(&relative, size, !is_dir)?;
        if is_dir {
            create_directory(root, &relative)?;
        } else {
            let mode = safe_file_mode(entry.unix_mode());
            write_file(root, &relative, &mut entry, size, mode)?;
        }
    }
    Ok(())
}

fn write_file<R: Read>(
    root: &Path,
    relative: &Path,
    reader: &mut R,
    declared_size: u64,
    mode: u32,
) -> Result<(), ArtifactError> {
    let output = root.join(relative);
    let parent = output
        .parent()
        .ok_or_else(|| ArtifactError::outside("archive output has no package parent"))?;
    std::fs::create_dir_all(parent)
        .map_err(|error| ArtifactError::archive_io("create archive parent directory", error))?;
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&output)
        .map_err(|error| ArtifactError::archive_io("create extracted file", error))?;
    let copied = std::io::copy(&mut reader.take(declared_size.saturating_add(1)), &mut file)
        .map_err(|error| ArtifactError::archive_io("write extracted file", error))?;
    if copied != declared_size {
        return Err(ArtifactError::new(
            ArtifactErrorCode::UnsafeArchive,
            format!(
                "archive entry {} declared {declared_size} bytes but produced {copied}",
                relative.display()
            ),
        ));
    }
    set_permissions(&output, mode)
}

fn validate_executable(root: &Path, relative: &Path) -> Result<PathBuf, ArtifactError> {
    let root = std::fs::canonicalize(root)
        .map_err(|error| ArtifactError::archive_io("canonicalize package root", error))?;
    let executable = root.join(relative);
    let metadata = std::fs::symlink_metadata(&executable).map_err(|error| {
        ArtifactError::new(
            ArtifactErrorCode::ExecutableMissing,
            format!(
                "managed executable {} is unavailable: {error}",
                executable.display()
            ),
        )
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(ArtifactError::new(
            ArtifactErrorCode::ExecutableMissing,
            format!(
                "managed executable {} is not a regular file",
                executable.display()
            ),
        ));
    }
    let canonical = std::fs::canonicalize(&executable)
        .map_err(|error| ArtifactError::archive_io("canonicalize managed executable", error))?;
    if !canonical.starts_with(&root) {
        return Err(ArtifactError::outside(
            "managed executable resolved outside package root",
        ));
    }
    ensure_executable(&canonical, &metadata)?;
    Ok(canonical)
}

#[cfg(unix)]
fn ensure_executable(path: &Path, metadata: &std::fs::Metadata) -> Result<(), ArtifactError> {
    use std::os::unix::fs::PermissionsExt as _;
    if metadata.permissions().mode() & 0o111 == 0 {
        return Err(ArtifactError::new(
            ArtifactErrorCode::ExecutableMissing,
            format!(
                "managed executable {} has no executable bit",
                path.display()
            ),
        ));
    }
    Ok(())
}

#[cfg(not(unix))]
fn ensure_executable(_path: &Path, _metadata: &std::fs::Metadata) -> Result<(), ArtifactError> {
    Ok(())
}

fn open_artifact(path: &Path) -> Result<File, ArtifactError> {
    File::open(path).map_err(|error| ArtifactError::archive_io("open verified artifact", error))
}

fn archive_too_large() -> ArtifactError {
    ArtifactError::new(
        ArtifactErrorCode::ArchiveTooLarge,
        format!("archive exceeds {MAX_UNCOMPRESSED_BYTES} uncompressed bytes"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest as _, Sha256};
    use std::io::{Cursor, Write as _};

    fn verified(path: &Path, source_name: &str) -> VerifiedArtifact {
        let bytes = std::fs::read(path).unwrap();
        let digest = Sha256::digest(&bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        super::super::download::verify_local_artifact(path, source_name, &digest).unwrap()
    }

    fn zip_file(entries: &[(&str, &[u8], u32)]) -> tempfile::NamedTempFile {
        let mut file = tempfile::NamedTempFile::new().unwrap();
        {
            let mut zip = zip::ZipWriter::new(file.as_file_mut());
            for (name, bytes, mode) in entries {
                let options = zip::write::SimpleFileOptions::default().unix_permissions(*mode);
                zip.start_file(*name, options).unwrap();
                zip.write_all(bytes).unwrap();
            }
            zip.finish().unwrap();
        }
        file
    }

    fn tar_gzip(entries: &[(&str, &[u8], u32, tar::EntryType)]) -> tempfile::NamedTempFile {
        let file = tempfile::NamedTempFile::new().unwrap();
        {
            let encoder = flate2::write::GzEncoder::new(
                file.as_file().try_clone().unwrap(),
                flate2::Compression::default(),
            );
            let mut archive = tar::Builder::new(encoder);
            for (name, bytes, mode, kind) in entries {
                let mut header = tar::Header::new_gnu();
                header.set_entry_type(*kind);
                header.set_mode(*mode);
                header.set_size(bytes.len() as u64);
                header.set_cksum();
                archive
                    .append_data(&mut header, *name, Cursor::new(*bytes))
                    .unwrap();
            }
            archive.into_inner().unwrap().finish().unwrap();
        }
        file
    }

    #[test]
    fn extracts_raw_zip_and_tar_gzip() {
        let raw = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(raw.path(), b"raw-agent").unwrap();
        let root = tempfile::tempdir().unwrap().path().join("raw");
        let result = extract_verified(&verified(raw.path(), "agent"), &root, "bin/agent").unwrap();
        assert_eq!(std::fs::read(result.executable()).unwrap(), b"raw-agent");

        let zip = zip_file(&[("bin/agent", b"zip-agent", 0o755)]);
        let root = tempfile::tempdir().unwrap().path().join("zip");
        let result =
            extract_verified(&verified(zip.path(), "agent.zip"), &root, "bin/agent").unwrap();
        assert_eq!(std::fs::read(result.executable()).unwrap(), b"zip-agent");

        let tar = tar_gzip(&[("bin/agent", b"tar-agent", 0o755, tar::EntryType::Regular)]);
        let root = tempfile::tempdir().unwrap().path().join("tar");
        let result =
            extract_verified(&verified(tar.path(), "agent.tgz"), &root, "bin/agent").unwrap();
        assert_eq!(std::fs::read(result.executable()).unwrap(), b"tar-agent");
    }

    #[test]
    fn rejects_traversal_duplicates_links_and_unsafe_modes() {
        let zip = zip_file(&[("../escape", b"bad", 0o755)]);
        let root = tempfile::tempdir().unwrap().path().join("out");
        let error =
            extract_verified(&verified(zip.path(), "agent.zip"), &root, "bin/agent").unwrap_err();
        assert_eq!(error.code, ArtifactErrorCode::ExecutableOutsidePackage);

        // zip 6 refuses to construct duplicate names, so use TAR to exercise
        // the extractor's own format-independent duplicate-path guard.
        let duplicate = tar_gzip(&[
            ("bin/agent", b"one", 0o755, tar::EntryType::Regular),
            ("bin/agent", b"two", 0o755, tar::EntryType::Regular),
        ]);
        let root = tempfile::tempdir().unwrap().path().join("out");
        let error = extract_verified(&verified(duplicate.path(), "agent.tgz"), &root, "bin/agent")
            .unwrap_err();
        assert_eq!(error.code, ArtifactErrorCode::DuplicatePath);

        let tar = tar_gzip(&[("link", b"target", 0o755, tar::EntryType::Symlink)]);
        let root = tempfile::tempdir().unwrap().path().join("out");
        let error =
            extract_verified(&verified(tar.path(), "agent.tgz"), &root, "link").unwrap_err();
        assert_eq!(error.code, ArtifactErrorCode::UnsafeArchive);

        let zip = zip_file(&[("bin/agent", b"bad-mode", 0o777)]);
        let root = tempfile::tempdir().unwrap().path().join("out");
        let error =
            extract_verified(&verified(zip.path(), "agent.zip"), &root, "bin/agent").unwrap_err();
        assert_eq!(error.code, ArtifactErrorCode::UnsafePermissions);
    }

    #[test]
    fn rejects_nonempty_roots_missing_executables_and_unsupported_archives() {
        let raw = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(raw.path(), b"agent").unwrap();
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("existing"), b"x").unwrap();
        let error =
            extract_verified(&verified(raw.path(), "agent"), root.path(), "agent").unwrap_err();
        assert_eq!(error.code, ArtifactErrorCode::UnsafeArchive);

        let zip = zip_file(&[("README.md", b"docs", 0o644)]);
        let root = tempfile::tempdir().unwrap().path().join("out");
        let error =
            extract_verified(&verified(zip.path(), "agent.zip"), &root, "bin/agent").unwrap_err();
        assert_eq!(error.code, ArtifactErrorCode::ExecutableMissing);

        let root = tempfile::tempdir().unwrap().path().join("out");
        let error =
            extract_verified(&verified(raw.path(), "agent.rar"), &root, "agent").unwrap_err();
        assert_eq!(error.code, ArtifactErrorCode::UnsupportedArchive);
    }

    #[test]
    fn extraction_limits_fail_before_writing_declared_oversize_file() {
        let mut budget = ExtractionBudget::default();
        let error = budget
            .register(Path::new("huge"), MAX_SINGLE_FILE_BYTES + 1, true)
            .unwrap_err();
        assert_eq!(error.code, ArtifactErrorCode::ArchiveTooLarge);

        let mut budget = ExtractionBudget::default();
        budget.entry_count = MAX_ARCHIVE_ENTRIES;
        let error = budget.register(Path::new("extra"), 0, false).unwrap_err();
        assert_eq!(error.code, ArtifactErrorCode::TooManyEntries);
    }
}
