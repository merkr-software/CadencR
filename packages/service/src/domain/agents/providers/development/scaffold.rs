use std::io::Write;
use std::path::Path;

use crate::error::AppError;

const GITIGNORE: &str = r#"/target/
/dist/
/node_modules/
/bin/*
!/bin/.gitkeep
.DS_Store
.env
"#;
const WORKSPACE_MARKER: &str = ".cadencr-provider-workspace";

pub(super) fn write(
    directory: &Path,
    provider_id: &str,
    display_name: &str,
    executable_relative: &Path,
) -> Result<(), AppError> {
    let executable = executable_relative.to_string_lossy();
    write_file_if_missing(&directory.join(WORKSPACE_MARKER), provider_id)?;
    write_file_if_missing(
        &directory.join("README.md"),
        &readme(provider_id, display_name, &executable),
    )?;
    write_file_if_missing(
        &directory.join("INSTRUCTION.md"),
        &instruction(provider_id, display_name, &executable),
    )?;
    write_file_if_missing(&directory.join(".gitignore"), GITIGNORE)?;
    std::fs::create_dir_all(directory.join("bin")).map_err(|error| {
        AppError::Internal(format!("failed to create provider bin directory: {error}"))
    })?;
    write_file_if_missing(&directory.join("bin/.gitkeep"), "")
}

pub(super) fn can_resume(directory: &Path, provider_id: &str) -> Result<bool, AppError> {
    let mut entries = std::fs::read_dir(directory).map_err(|error| {
        AppError::Internal(format!(
            "failed to inspect provider workspace {}: {error}",
            directory.display()
        ))
    })?;
    if entries.next().is_none() {
        return Ok(true);
    }
    match std::fs::read_to_string(directory.join(WORKSPACE_MARKER)) {
        Ok(marker) => Ok(marker.trim() == provider_id),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(AppError::Internal(format!(
            "failed to read provider workspace marker: {error}"
        ))),
    }
}

fn write_file_if_missing(path: &Path, content: &str) -> Result<(), AppError> {
    let mut file = match std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
    {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => return Ok(()),
        Err(error) => {
            return Err(AppError::Internal(format!(
                "failed to create {}: {error}",
                path.display()
            )))
        }
    };
    file.write_all(content.as_bytes())
        .map_err(|error| AppError::Internal(format!("failed to write {}: {error}", path.display())))
}

fn readme(provider_id: &str, display_name: &str, executable: &str) -> String {
    format!(
        r#"# Cadencr provider: {display_name}

This repository is the development workspace for the `{provider_id}` provider connector.
It is an ordinary Cadencr project: use your normal agent, panes, Git workflow, and worktree settings.

## Start here

1. Ask your agent to **read `INSTRUCTION.md` and implement the complete connector**.
2. Review and merge the agent's work into this repository's main checkout if your normal workflow used a worktree.
3. Build the connector so the executable exists at `{executable}`.
4. Restart Cadencr after every connector change before testing it.
5. Select **{display_name}** and one of its discovered models in a normal conversation.

> Cadencr does not hot-reload provider executables or registrations. Restarting between changes is required for a reliable test.

## Files

| Path | Purpose |
| --- | --- |
| `.cadencr-provider-workspace` | Marks this Cadencr-owned repository so an interrupted creation can be retried safely |
| `INSTRUCTION.md` | Complete executable, model discovery, ACP v1, and validation contract for the implementing agent |
| `icon.svg` | Connector-owned provider logo loaded by Cadencr from this repository |
| `{executable}` | Stable local build output launched directly by Cadencr |
| `bin/.gitkeep` | Keeps the build-output directory in Git without committing generated binaries |

## Scope

This is a local developer workflow, not marketplace installation. A future marketplace will add signed packages, assets, integrity checks, conformance, upgrades, and uninstall policy. Do not treat this repository or its host-local descriptor as a published package yet.
"#
    )
}

fn instruction(provider_id: &str, display_name: &str, executable: &str) -> String {
    include_str!("templates/INSTRUCTION.md")
        .replace("__PROVIDER_ID__", provider_id)
        .replace("__DISPLAY_NAME__", display_name)
        .replace("__EXECUTABLE__", executable)
}

#[cfg(test)]
mod tests {
    use super::{can_resume, instruction, readme, write};
    use std::path::Path;

    #[test]
    fn scaffold_names_the_required_commands_and_restart_gate() {
        let instruction = instruction("pi-connector", "Pi", "bin/provider");
        for required in [
            "models --format acp-config-options-v1",
            "run --protocol acp-v1",
            "version",
            "session/set_config_option",
            "icon.svg",
            "restart Cadencr",
        ] {
            assert!(instruction.contains(required), "missing {required}");
        }
        assert!(instruction.starts_with("# Implement the Pi provider connector"));
        assert!(!instruction.contains("__PROVIDER_ID__"));
        assert!(!instruction.contains("__DISPLAY_NAME__"));
        assert!(!instruction.contains("__EXECUTABLE__"));
        let readme = readme("pi-connector", "Pi", "bin/provider");
        assert!(readme.contains("ordinary Cadencr project"));
        assert!(readme.contains("Restart Cadencr after every connector change"));
    }

    #[test]
    fn retry_fills_missing_files_without_overwriting_user_work() {
        let temp = tempfile::tempdir().unwrap();
        write(temp.path(), "pi-connector", "Pi", Path::new("bin/provider")).unwrap();
        std::fs::write(temp.path().join("README.md"), "user edit").unwrap();

        assert!(can_resume(temp.path(), "pi-connector").unwrap());
        write(
            temp.path(),
            "pi-connector",
            "Different label",
            Path::new("bin/provider"),
        )
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(temp.path().join("README.md")).unwrap(),
            "user edit"
        );
    }
}
