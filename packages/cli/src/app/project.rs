//! `cadencr add`: add a folder as a project.
//!
//! With a headless service running, the CLI adds it over that service's API.
//! Otherwise the desktop app adds it, so it can open it and report errors.

use std::path::Path;

use super::connection::Connection;
use super::service_api::ServiceApi;
use super::{block_on, launch};
use crate::{operation_error, Diagnostic};

pub(super) fn add(path: &Path) -> Result<Option<String>, Diagnostic> {
    let path = launch::canonical(path)?;
    if !path.is_dir() {
        return Err(operation_error(
            "CLI_NOT_A_DIRECTORY",
            format!("{} is not a folder", path.display()),
        ));
    }
    match Connection::running()? {
        Some(connection) => block_on(add_headless(&connection, &path))?,
        None => {
            launch::add(&path)?;
            Ok(Some(format!("Adding {} in CadencR.", path.display())))
        }
    }
}

async fn add_headless(connection: &Connection, path: &Path) -> Result<Option<String>, Diagnostic> {
    let api = ServiceApi::new(connection.base_url(), connection.token.clone())?;
    // The service does not deduplicate: two rows for one folder would show the
    // project twice. Projects keep the path they were added with, which may go
    // through a symlink, so compare resolved paths.
    let projects = api.projects().await?;
    let same_folder = |stored: &Path| {
        stored == path || std::fs::canonicalize(stored).is_ok_and(|real| real == path)
    };
    if let Some(existing) = projects.iter().find(|project| same_folder(&project.path)) {
        return Ok(Some(format!(
            "{} is already the project \"{}\" (id {}).",
            path.display(),
            existing.name,
            existing.id
        )));
    }
    let name = project_name(path)?;
    let project = api.create_project(&name, path).await?;
    Ok(Some(format!(
        "Added the project \"{}\" (id {}) for {}.",
        project.name,
        project.id,
        project.path.display()
    )))
}

/// The folder name, as the desktop app names a project it adds.
fn project_name(path: &Path) -> Result<String, Diagnostic> {
    path.file_name()
        .and_then(|name| name.to_str())
        .map(str::to_string)
        .ok_or_else(|| {
            operation_error(
                "CLI_PROJECT_NAME_INVALID",
                format!("cannot name a project after {}", path.display()),
            )
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn projects_are_named_after_their_folder() {
        assert_eq!(project_name(Path::new("/src/my-app")).unwrap(), "my-app");
        assert_eq!(
            project_name(Path::new("/")).unwrap_err().code,
            "CLI_PROJECT_NAME_INVALID"
        );
    }

    #[test]
    fn adding_a_file_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("notes.txt");
        std::fs::write(&file, b"").unwrap();
        assert_eq!(add(&file).unwrap_err().code, "CLI_NOT_A_DIRECTORY");
    }
}
