//! What Cadencr leaves in a theme folder for whoever is editing it.
//!
//! A theme opens as a project with `theme.json` in one pane and an agent in the
//! other, and until these files existed the agent had nothing but the document
//! itself to infer the format from. That works for colors — the keys are CSS
//! custom properties — and fails for [`chrome`](super::chrome), where seeing
//! `"chassis": "rail"` tells you nothing about what else is allowed.
//!
//! So the folder carries its own documentation: `THEME.md` for prose and
//! `theme.schema.json` for the machine-checkable half, the latter generated from
//! the same constants the validator uses.
//!
//! And it carries its own *boundary*. An agent that can't express something in
//! `theme.json` will look for another way to satisfy the request, and in a
//! development checkout the app's own stylesheets are a few directories up — one
//! did exactly that, editing the shared segmented-tab rules to recolor a single
//! theme. `AGENTS.md`/`CLAUDE.md` say the folder is the whole world, and say
//! what to do instead: report the limit. See [`AGENT_FILE_NAMES`].
//!
//! Both are the app's, not the theme's, and are kept out of git accordingly —
//! see [`exclude_from_git`].

use std::path::Path;

use tokio::fs;

use crate::error::AppError;

use super::schema;

pub const REFERENCE_FILE_NAME: &str = "THEME.md";

/// The launcher that runs the app's own validation on this folder. A shell
/// script rather than a documented command line because it is the one thing in
/// here the agent has to *use*, not read: `./check-theme` is short enough to be
/// typed from memory, and shows up in a plain `ls`.
pub const CHECK_FILE_NAME: &str = if cfg!(windows) {
    "check-theme.cmd"
} else {
    "check-theme"
};

/// The files a coding agent loads on its own, before anyone asks it to read
/// anything. `THEME.md` explains the format but is only opened by an agent that
/// decides to; the boundary — *this folder is the whole theme, never edit the
/// app* — has to be in the file that is always in context.
///
/// Two names for one text because that is how the convention actually landed:
/// `AGENTS.md` is what Codex, OpenCode and Cursor read, `CLAUDE.md` is what
/// Claude Code reads. It is a pair of filenames, not a behavior branch — nothing
/// here asks which provider is running.
pub const AGENT_FILE_NAMES: [&str; 2] = ["AGENTS.md", "CLAUDE.md"];

const REFERENCE: &str = include_str!("scaffold/THEME.md");
const BOUNDARY: &str = include_str!("scaffold/AGENTS.md");

/// The schema is derived from constants, so it is the same document every time.
/// Rendering it per open would rebuild ~110 properties and pretty-print them
/// only for `write_if_changed` to find the file already identical.
static SCHEMA: std::sync::LazyLock<String> = std::sync::LazyLock::new(schema::render);

const EXCLUDE_HEADER: &str =
    "# Written by Cadencr for whoever edits this theme. Not part of the theme.";

/// Put the reference, the schema and the check command in a theme folder, and
/// keep git quiet about all three.
///
/// Runs on every open, not only at creation: these files belong to the app, so a
/// theme made before they existed — or opened after an update changed them — has
/// to come away with the current set. Failures are reported rather than logged,
/// because a theme folder Cadencr cannot write to is a problem the user is about
/// to hit again when they try to save.
pub async fn refresh(dir: &Path) -> Result<(), AppError> {
    write_if_changed(&dir.join(REFERENCE_FILE_NAME), REFERENCE).await?;
    write_if_changed(&dir.join(schema::SCHEMA_FILE_NAME), &SCHEMA).await?;
    for name in AGENT_FILE_NAMES {
        write_if_changed(&dir.join(name), BOUNDARY).await?;
    }
    write_check_command(dir).await?;
    exclude_from_git(dir).await
}

/// Write the `check-theme` launcher, pointing at the executable running right
/// now.
///
/// `current_exe` rather than a name on `PATH`: in development that is the
/// service binary in this worktree's target dir, and in a packaged build it is
/// the sidecar inside the app bundle — neither is installed anywhere a shell
/// would find it. Rewritten on every open, so the path follows the app across
/// updates and rebuilds.
async fn write_check_command(dir: &Path) -> Result<(), AppError> {
    let exe = std::env::current_exe()
        .map_err(|e| AppError::internal(format!("could not locate the Cadencr binary: {e}")))?;
    let exe = exe.display();
    let path = dir.join(CHECK_FILE_NAME);
    let script = if cfg!(windows) {
        format!(
            "@echo off\r\n\
             REM Written by Cadencr. Validates this theme exactly as the app does.\r\n\
             \"{exe}\" check-theme \"%~dp0.\"\r\n"
        )
    } else {
        format!(
            "#!/bin/sh\n\
             # Written by Cadencr. Validates this theme exactly as the app does.\n\
             exec \"{exe}\" check-theme \"$(CDPATH= cd -- \"$(dirname -- \"$0\")\" && pwd)\"\n"
        )
    };
    write_if_changed(&path, &script).await?;
    make_executable(&path).await
}

#[cfg(unix)]
async fn make_executable(path: &Path) -> Result<(), AppError> {
    use std::os::unix::fs::PermissionsExt;

    let mut permissions = fs::metadata(path)
        .await
        .map_err(|e| AppError::internal(format!("failed to read {}: {e}", path.display())))?
        .permissions();
    if permissions.mode() & 0o111 == 0o111 {
        return Ok(());
    }
    permissions.set_mode(0o755);
    fs::set_permissions(path, permissions)
        .await
        .map_err(|e| AppError::internal(format!("failed to chmod {}: {e}", path.display())))
}

#[cfg(not(unix))]
async fn make_executable(_path: &Path) -> Result<(), AppError> {
    // `.cmd` is executable by extension.
    Ok(())
}

/// Most opens change nothing, and rewriting an identical file would still bump
/// its mtime — which the editor and every file watcher below it react to.
///
/// The write that does happen goes through `atomic_file`, like every other
/// document the app owns in a folder someone else is watching: `theme.schema.json`
/// is typically open in the pane beside `theme.json`, and a reader must never
/// catch it half-written.
async fn write_if_changed(path: &Path, content: &str) -> Result<(), AppError> {
    if matches!(fs::read_to_string(path).await, Ok(existing) if existing == content) {
        return Ok(());
    }
    crate::shared::atomic_file::write_atomic(path, content)
}

/// Everything `refresh` writes.
pub const GENERATED: [&str; 5] = [
    REFERENCE_FILE_NAME,
    schema::SCHEMA_FILE_NAME,
    AGENT_FILE_NAMES[0],
    AGENT_FILE_NAMES[1],
    CHECK_FILE_NAME,
];

/// `.git/info/exclude`, not `.gitignore`.
///
/// The tracked ignore file is the theme's, and these files are not: adding them
/// to it would put an unexplained diff in the Git tab of every theme that
/// already exists, and committing the files themselves would dirty every theme
/// repository the next time an app update reworded a paragraph — or moved the
/// binary the check command points at. The user's history stays about their
/// colors.
///
/// Appended rather than written, and only the entries actually missing:
/// `.git/info/exclude` may hold entries the user put there, and a later release
/// adding another file must not re-list the ones already there.
async fn exclude_from_git(dir: &Path) -> Result<(), AppError> {
    let git = dir.join(".git");
    // A theme folder is made a repository when its project is created; if that
    // hasn't happened yet there is nothing to hide the files from.
    if !git.is_dir() {
        return Ok(());
    }
    let path = git.join("info").join("exclude");
    let existing = fs::read_to_string(&path).await.unwrap_or_default();
    let missing: Vec<&str> = GENERATED
        .iter()
        .copied()
        .filter(|name| !existing.lines().any(|line| line.trim() == *name))
        .collect();
    if missing.is_empty() {
        return Ok(());
    }

    let mut next = existing;
    if !next.is_empty() && !next.ends_with('\n') {
        next.push('\n');
    }
    if !next.contains(EXCLUDE_HEADER) {
        next.push_str(EXCLUDE_HEADER);
        next.push('\n');
    }
    for name in missing {
        next.push_str(name);
        next.push('\n');
    }

    let info = path.parent().expect("exclude lives in .git/info");
    fs::create_dir_all(info)
        .await
        .map_err(|e| AppError::internal(format!("failed to create {}: {e}", info.display())))?;
    fs::write(&path, next)
        .await
        .map_err(|e| AppError::internal(format!("failed to write {}: {e}", path.display())))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::themes::chrome::{
        ThemeBlend, ThemeChassis, ThemeImageFit, ThemeTabs, ASSET_EXTENSIONS, GRAIN_SCALE,
        HALO_BLUR, HALO_DRIFT, HALO_OFFSET, HALO_SIZE, IMAGE_SCALE, MAX_HALOS, OPACITY,
    };
    use crate::domain::themes::paths;
    use crate::domain::themes::schema::names;

    /// A theme folder in this test's own isolated themes dir (see
    /// `settings_store::dir`), so each case gets a clean one.
    fn theme_dir(id: &str) -> std::path::PathBuf {
        let dir = paths::theme_dir(id).expect("valid id");
        std::fs::create_dir_all(&dir).expect("theme dir");
        dir
    }

    /// The reference is prose and the vocabulary is code, so the two can drift
    /// silently. Every value a theme may actually write has to be named in the
    /// document the agent reads, or the agent's only source is incomplete.
    #[test]
    fn the_reference_names_every_value_a_theme_may_use() {
        for value in names(ThemeChassis::ALL)
            .into_iter()
            .chain(names(ThemeTabs::ALL))
            .chain(names(ThemeBlend::ALL))
            .chain(names(ThemeImageFit::ALL))
        {
            assert!(
                REFERENCE.contains(&format!("`{value}`")),
                "THEME.md never mentions `{value}`"
            );
        }
        for extension in ASSET_EXTENSIONS {
            assert!(
                REFERENCE.contains(&format!("`{extension}`")),
                "THEME.md never mentions `{extension}`"
            );
        }
        assert!(REFERENCE.contains(&format!("up to {MAX_HALOS} drifting")));
    }

    /// An optional token nobody documents may as well not exist: it is absent
    /// from the file being edited, so the only way to learn it is settable is to
    /// be told.
    #[test]
    fn the_reference_names_every_optional_token() {
        for token in crate::domain::themes::tokens::OPTIONAL_TOKENS {
            assert!(
                REFERENCE.contains(&format!("`{token}`")),
                "THEME.md never mentions `{token}`"
            );
        }
    }

    /// The reference's whole job is to get the check command run. If the file
    /// stops naming it, the agent is back to guessing whether its theme applies.
    #[test]
    fn the_reference_leads_with_the_check_command() {
        let head = &REFERENCE[..REFERENCE.len().min(700)];
        assert!(head.contains("./check-theme"), "{head}");
        assert!(REFERENCE.contains("check-theme.cmd"));
    }

    #[tokio::test]
    async fn writes_a_check_command_that_runs_this_binary_against_this_folder() {
        let dir = theme_dir("check-command");
        refresh(&dir).await.expect("refreshes");

        let path = dir.join(CHECK_FILE_NAME);
        let script = std::fs::read_to_string(&path).expect("read");
        let exe = std::env::current_exe().expect("exe");

        assert!(script.contains(&exe.display().to_string()), "{script}");
        assert!(script.contains("check-theme"), "{script}");
    }

    /// Written to be *run*, so the bit that makes that possible is part of the
    /// contract, not an implementation detail.
    #[cfg(unix)]
    #[tokio::test]
    async fn the_check_command_is_executable() {
        use std::os::unix::fs::PermissionsExt;

        let dir = theme_dir("executable");
        refresh(&dir).await.expect("refreshes");

        let mode = std::fs::metadata(dir.join(CHECK_FILE_NAME))
            .expect("metadata")
            .permissions()
            .mode();
        assert_eq!(mode & 0o111, 0o111, "{mode:o}");
    }

    /// Same guard for the numbers: a bound the validator moved but the reference
    /// still quotes is worse than no bound at all, because it reads as certain.
    #[test]
    fn the_reference_quotes_the_bounds_the_validator_enforces() {
        for (min, max) in [
            HALO_SIZE,
            HALO_OFFSET,
            HALO_BLUR,
            HALO_DRIFT,
            OPACITY,
            GRAIN_SCALE,
            IMAGE_SCALE,
        ] {
            let range = format!("`{min} … {max}`");
            assert!(REFERENCE.contains(&range), "THEME.md never states {range}");
        }
    }

    #[tokio::test]
    async fn writes_both_files_and_leaves_them_alone_on_the_next_open() {
        let dir = theme_dir("writes-both");
        refresh(&dir).await.expect("refreshes");

        let reference = dir.join(REFERENCE_FILE_NAME);
        let schema_file = dir.join(schema::SCHEMA_FILE_NAME);
        assert_eq!(
            std::fs::read_to_string(&reference).expect("read"),
            REFERENCE
        );
        serde_json::from_str::<serde_json::Value>(
            &std::fs::read_to_string(&schema_file).expect("read"),
        )
        .expect("the schema is JSON");

        let stamped = std::fs::metadata(&reference)
            .expect("metadata")
            .modified()
            .expect("mtime");
        refresh(&dir).await.expect("refreshes again");
        assert_eq!(
            std::fs::metadata(&reference)
                .expect("metadata")
                .modified()
                .expect("mtime"),
            stamped,
            "an unchanged file must not be rewritten"
        );
    }

    /// The boundary is only worth anything if it is already in context when the
    /// agent's first instruction arrives, so it goes in the files every agent
    /// loads by itself — under both names, with the same text.
    #[tokio::test]
    async fn the_boundary_is_written_under_every_name_an_agent_reads() {
        let dir = theme_dir("boundary");
        refresh(&dir).await.expect("refreshes");

        for name in AGENT_FILE_NAMES {
            assert_eq!(
                std::fs::read_to_string(dir.join(name)).expect("read"),
                BOUNDARY,
                "{name}"
            );
        }
    }

    /// What the boundary has to actually say. Wording can change; these three
    /// things can't, because each one is a failure that has happened: the agent
    /// edited the app instead of the theme, it never ran the validator, and it
    /// had no sanctioned way to report that a request wasn't a theme setting.
    #[test]
    fn the_boundary_forbids_the_app_demands_the_check_and_offers_a_way_out() {
        assert!(BOUNDARY.contains("Never edit Cadencr's own source"));
        assert!(BOUNDARY.contains("./check-theme"));
        assert!(BOUNDARY.contains("stop.**"));
    }

    /// The point of `.git/info/exclude`: the files are there, and `git status`
    /// never mentions them.
    #[tokio::test]
    async fn the_files_are_excluded_without_touching_the_theme_s_own_gitignore() {
        let dir = theme_dir("excluded");
        std::fs::create_dir_all(dir.join(".git").join("info")).expect("fake repo");
        std::fs::write(dir.join(".gitignore"), ".*.tmp\n").expect("gitignore");

        refresh(&dir).await.expect("refreshes");

        let exclude =
            std::fs::read_to_string(dir.join(".git").join("info").join("exclude")).expect("read");
        for name in GENERATED {
            assert!(exclude.contains(name), "{name} is missing from:\n{exclude}");
        }
        assert_eq!(
            std::fs::read_to_string(dir.join(".gitignore")).expect("read"),
            ".*.tmp\n",
            "the theme's own ignore file is not ours to edit"
        );
    }

    #[tokio::test]
    async fn keeps_entries_someone_else_put_in_exclude() {
        let dir = theme_dir("keeps-entries");
        std::fs::create_dir_all(dir.join(".git").join("info")).expect("fake repo");
        let exclude = dir.join(".git").join("info").join("exclude");
        std::fs::write(&exclude, "scratch/\n").expect("seed");

        refresh(&dir).await.expect("refreshes");
        refresh(&dir).await.expect("refreshes again");

        let content = std::fs::read_to_string(&exclude).expect("read");
        assert!(content.starts_with("scratch/\n"), "{content}");
        assert_eq!(
            content.matches(REFERENCE_FILE_NAME).count(),
            1,
            "a second open must not append the block again:\n{content}"
        );
    }

    #[tokio::test]
    async fn a_folder_that_is_not_a_repository_still_gets_its_reference() {
        let dir = theme_dir("no-repo");
        refresh(&dir).await.expect("refreshes");
        assert!(dir.join(REFERENCE_FILE_NAME).exists());
        assert!(!dir.join(".git").exists());
    }
}
