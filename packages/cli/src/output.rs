use std::io::{self, Write};
use std::path::Path;

use crate::Diagnostic;

pub(crate) fn write_bytes(bytes: &[u8], output: Option<&Path>) -> Result<(), Diagnostic> {
    match output {
        Some(path) => publish(path, |temporary| {
            temporary.write_all(bytes)?;
            temporary.flush()
        }),
        None => write_stdout(bytes, &mut io::stdout().lock()),
    }
}

pub(crate) fn write_stdout(bytes: &[u8], output: &mut impl Write) -> Result<(), Diagnostic> {
    output
        .write_all(bytes)
        .and_then(|()| output.flush())
        .map_err(|error| Diagnostic {
            code: "OUTPUT_WRITE_FAILED",
            message: format!("failed to write index to stdout: {error}"),
            exit_code: 3,
        })
}

pub(crate) fn publish(
    path: &Path,
    write_complete: impl FnOnce(&mut tempfile::NamedTempFile) -> io::Result<()>,
) -> Result<(), Diagnostic> {
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let mut temporary = private_temporary(parent).map_err(|error| output_error(path, error))?;
    write_complete(&mut temporary).map_err(|error| output_error(path, error))?;
    temporary
        .persist_noclobber(path)
        .map(|_| ())
        .map_err(|error| output_error(path, error.error))
}

#[cfg(unix)]
fn private_temporary(parent: &Path) -> io::Result<tempfile::NamedTempFile> {
    use std::os::unix::fs::PermissionsExt as _;
    tempfile::Builder::new()
        .permissions(std::fs::Permissions::from_mode(0o600))
        .tempfile_in(parent)
}

#[cfg(not(unix))]
fn private_temporary(parent: &Path) -> io::Result<tempfile::NamedTempFile> {
    tempfile::NamedTempFile::new_in(parent)
}

fn output_error(path: &Path, error: io::Error) -> Diagnostic {
    Diagnostic {
        code: "OUTPUT_WRITE_FAILED",
        message: format!("failed to create {}: {error}", path.display()),
        exit_code: 3,
    }
}

#[cfg(test)]
mod tests {
    use super::{publish, write_stdout};
    use std::io::{self, Write};

    #[test]
    fn failed_write_never_publishes_partial_output() {
        let directory = tempfile::tempdir().unwrap();
        let output = directory.path().join("index.json");
        let error = publish(&output, |temporary| {
            temporary.write_all(b"partial")?;
            Err(io::Error::new(io::ErrorKind::WriteZero, "injected failure"))
        })
        .unwrap_err();
        assert_eq!(error.code, "OUTPUT_WRITE_FAILED");
        assert!(!output.exists());
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 0);
    }

    #[test]
    fn stdout_flush_failure_is_reported() {
        struct FlushFails(Vec<u8>);
        impl Write for FlushFails {
            fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
                self.0.extend_from_slice(bytes);
                Ok(bytes.len())
            }
            fn flush(&mut self) -> io::Result<()> {
                Err(io::Error::new(io::ErrorKind::BrokenPipe, "closed stdout"))
            }
        }
        let error = write_stdout(b"complete bytes", &mut FlushFails(Vec::new())).unwrap_err();
        assert_eq!(error.code, "OUTPUT_WRITE_FAILED");
    }
}
