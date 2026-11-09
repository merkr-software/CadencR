//! Read/write user themes under `~/.cadencr/plugins/themes/<id>/theme.json`.
//!
//! Reads always go to disk (no cache) so an external edit shows up on the next
//! request, matching how the settings store behaves. Writes are atomic
//! (temp file + rename) so a reader — or the file watcher — never sees a
//! half-written theme.

use std::collections::BTreeMap;
use std::path::Path;

use tokio::fs;

use crate::error::AppError;

use super::assets;
use super::chrome::ThemeChrome;
use super::models::{ThemeAppearance, ThemeDocument, ThemeIssue, UserTheme, XtermPalette};
use super::paths::{self, THEME_FILE_NAME};
use super::schema;
use super::validate::validate;
use crate::shared::slug::slugify;

/// Every theme on disk, id-sorted, each with its validation verdict.
pub async fn list() -> Result<Vec<UserTheme>, AppError> {
    let dir = paths::themes_dir();
    let mut entries = match fs::read_dir(&dir).await {
        Ok(entries) => entries,
        // No themes dir yet simply means no user themes.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => {
            return Err(AppError::internal(format!(
                "failed to read {}: {e}",
                dir.display()
            )))
        }
    };

    let mut ids = Vec::new();
    while let Some(entry) = entries
        .next_entry()
        .await
        .map_err(|e| AppError::internal(format!("failed to read {}: {e}", dir.display())))?
    {
        let Some(id) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        if paths::is_valid_id(&id) {
            ids.push(id);
        }
    }
    ids.sort();

    // A directory without a `theme.json` isn't a theme — skip it rather than
    // failing the whole listing over one stray folder.
    let mut themes = Vec::with_capacity(ids.len());
    for id in ids {
        match get(&id).await {
            Ok(theme) => themes.push(theme),
            Err(AppError::NotFound(_)) => continue,
            Err(e) => return Err(e),
        }
    }
    Ok(themes)
}

/// Read one theme, validating it. A theme whose file is missing is a 404; a
/// theme whose file is *broken* is not — it is returned with its issues so the
/// gallery can show the user what to fix.
pub async fn get(id: &str) -> Result<UserTheme, AppError> {
    read_at(&paths::theme_dir(id)?).await
}

/// The same read, addressed by folder rather than by id.
///
/// This is what makes the `check-theme` command the app's own gate instead of a
/// second implementation of it: the agent editing a theme runs the very
/// function the gallery calls, on the very folder it is working in, and gets
/// the verdict the settings card would show.
pub async fn read_at(dir: &Path) -> Result<UserTheme, AppError> {
    let id = paths::id_of(dir);
    let path = dir.join(THEME_FILE_NAME);
    let content = fs::read_to_string(&path).await.map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            AppError::NotFound(format!("theme `{id}` not found"))
        } else {
            AppError::internal(format!("failed to read {}: {e}", path.display()))
        }
    })?;
    Ok(build(dir, &path, content).await)
}

async fn build(dir: &Path, path: &Path, content: String) -> UserTheme {
    let (label, document, mut issues) = match serde_json::from_str::<ThemeDocument>(&content) {
        Ok(parsed) => {
            let issues = validate(&parsed);
            (Some(parsed.label.clone()), Some(parsed), issues)
        }
        // The document didn't deserialize, but the file is usually still
        // perfectly good JSON with the theme's name sitting in it — an unknown
        // key under `chrome`, an `appearance` that is neither light nor dark.
        // The gallery has to be able to say *which* theme broke, and the sidebar
        // to keep naming its project, so read the label straight off the raw
        // value.
        Err(e) => (
            raw_label(&content),
            None,
            vec![ThemeIssue::document(e.to_string())],
        ),
    };

    // A texture's asset file is part of whether the theme can be applied: one
    // pointing at a file that isn't there paints nothing, so it is reported
    // here and the theme is held back like any other invalid one.
    let mut asset_urls = BTreeMap::new();
    if let Some(parsed) = &document {
        let (loaded, asset_issues) = assets::load(dir, parsed).await;
        asset_urls = loaded;
        issues.extend(asset_issues);
    }

    UserTheme {
        id: paths::id_of(dir).to_string(),
        path: path.display().to_string(),
        content,
        label,
        // Keep the label but drop the document: a theme that failed validation
        // must never be applicable, and the gallery still needs to name it.
        theme: if issues.is_empty() { document } else { None },
        issues,
        assets: asset_urls,
    }
}

/// The `label` a file declares, without deserializing the document — the only
/// field worth recovering when the rest of it won't parse. `None` when the file
/// isn't JSON at all, which is the one case with genuinely no name to show.
fn raw_label(content: &str) -> Option<String> {
    serde_json::from_str::<serde_json::Value>(content)
        .ok()?
        .get("label")?
        .as_str()
        .map(str::to_string)
}

/// Create a theme from a duplicated token set. Rejects an invalid document
/// outright — this path is machine-generated from a working theme, so anything
/// invalid here is a bug, not a user edit in progress.
///
/// `copy_assets_from` names the user theme being duplicated, when there is one,
/// so its texture files land in the new folder alongside the document that
/// references them.
#[bon::builder]
pub async fn create(
    label: &str,
    appearance: ThemeAppearance,
    css_vars: BTreeMap<String, String>,
    xterm: XtermPalette,
    #[builder(default)] chrome: ThemeChrome,
    copy_assets_from: Option<&str>,
) -> Result<UserTheme, AppError> {
    let document = ThemeDocument {
        // Written into the file, not just implied: the schema is what tells an
        // editor — and the agent that will be editing this next — the shape of
        // everything below it. `scaffold` puts the file it names in the folder.
        schema: Some(schema::SCHEMA_REFERENCE.to_string()),
        label: label.trim().to_string(),
        appearance,
        css_vars,
        xterm,
        chrome,
    };
    let issues = validate(&document);
    if let Some(first) = issues.first() {
        return Err(AppError::BadRequest(format!(
            "theme is not valid: {}",
            first.describe()
        )));
    }

    // `slugify` yields "" for a label with no alphanumerics; an id has to be a
    // usable path segment, so fall back rather than fail the create.
    let slug = slugify(&document.label);
    let base = if slug.is_empty() { "theme" } else { &slug };
    let id = next_available_id(base).await?;
    let content = serde_json::to_string_pretty(&document)
        .map_err(|e| AppError::internal(format!("failed to serialize theme: {e}")))?;
    write_file(&id, &format!("{content}\n")).await?;
    // Best-effort, as before: a source that isn't a theme leaves the new theme
    // carrying the same "no such file" issue the original would have, which is
    // a theme to fix rather than a create to refuse.
    if let (Some(Ok(source)), Ok(target)) = (
        copy_assets_from.map(paths::theme_dir),
        paths::theme_dir(&id),
    ) {
        assets::copy_from(&source, &target, &document).await;
    }
    get(&id).await
}

/// Replace a theme's file with `content` verbatim.
///
/// Deliberately accepts content that fails validation: the user is editing, and
/// a rejected save would mean a half-finished edit could never be persisted.
/// The returned theme carries the issues, and an invalid theme is simply never
/// applied — the gate lives on load, where it protects the UI.
pub async fn write(id: &str, content: &str) -> Result<UserTheme, AppError> {
    // Read first so an unknown id is a 404 rather than a silent create: `write`
    // replaces an existing theme, `create` makes new ones.
    get(id).await?;
    write_file(id, content).await?;
    get(id).await
}

/// To the trash, not gone. The folder is a git repository the user built a
/// theme in — the palette, its history and the conversation about it — so a
/// mis-click has to be recoverable the way it is everywhere else on their
/// machine.
pub async fn delete(id: &str) -> Result<(), AppError> {
    let dir = paths::theme_dir(id)?;
    // Only a missing directory is a 404 — a folder that is there but can't be
    // read is a failure the user has to hear about, not "no such theme".
    if let Err(e) = fs::metadata(&dir).await {
        return Err(match e.kind() {
            std::io::ErrorKind::NotFound => AppError::NotFound(format!("theme `{id}` not found")),
            _ => AppError::internal(format!("failed to read theme `{id}`: {e}")),
        });
    }
    crate::shared::trash::move_to_trash(&dir).await
}

/// Append `-2`, `-3`, … until the slug is free, so duplicating the same theme
/// twice never overwrites the first copy.
async fn next_available_id(base: &str) -> Result<String, AppError> {
    for suffix in 1..1000 {
        let candidate = if suffix == 1 {
            base.to_string()
        } else {
            format!("{base}-{suffix}")
        };
        if fs::metadata(paths::theme_dir(&candidate)?).await.is_err() {
            return Ok(candidate);
        }
    }
    Err(AppError::internal("could not find an unused theme id"))
}

/// Atomic write into an owner-only (`0700`) theme directory.
async fn write_file(id: &str, content: &str) -> Result<(), AppError> {
    let dir = paths::theme_dir(id)?;
    let path = dir.join(THEME_FILE_NAME);
    crate::remote::secure_fs::create_dir_owner_only(&dir)
        .map_err(|e| AppError::internal(format!("failed to create {}: {e}", dir.display())))?;
    // Dot-prefixed so the watcher's filter skips it (it only reports
    // `theme.json`), keeping our own write from racing a reload of a partial file.
    crate::shared::atomic_file::write_atomic(&path, content)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::themes::chrome::{
        ThemeBlend, ThemeChassis, ThemeGrain, ThemeHalo, ThemeTabs, ThemeTexture,
    };
    use crate::domain::themes::test_support::{dracula_css_vars, dracula_xterm};

    async fn create_dracula(label: &str) -> UserTheme {
        create()
            .label(label)
            .appearance(ThemeAppearance::Dark)
            .css_vars(dracula_css_vars())
            .xterm(dracula_xterm())
            .call()
            .await
            .expect("creates")
    }

    #[tokio::test]
    async fn listing_an_absent_themes_dir_is_empty_not_an_error() {
        assert!(list().await.expect("lists").is_empty());
    }

    #[tokio::test]
    async fn creates_reads_and_deletes_a_theme() {
        let created = create_dracula("My Theme").await;
        assert_eq!(created.id, "my-theme");
        assert!(created.issues.is_empty());
        assert_eq!(created.theme.expect("valid").label, "My Theme");

        let listed = list().await.expect("lists");
        assert_eq!(listed.len(), 1);
        assert!(listed[0].path.ends_with("my-theme/theme.json"));

        delete("my-theme").await.expect("deletes");
        assert!(list().await.expect("lists").is_empty());
        assert!(get("my-theme").await.is_err());
    }

    #[tokio::test]
    async fn duplicating_the_same_label_never_overwrites() {
        assert_eq!(create_dracula("My Theme").await.id, "my-theme");
        assert_eq!(create_dracula("My Theme").await.id, "my-theme-2");
        assert_eq!(list().await.expect("lists").len(), 2);
    }

    #[tokio::test]
    async fn a_broken_file_is_listed_with_issues_and_never_applied() {
        let created = create_dracula("My Theme").await;
        // Exactly what a user editing the file on disk does: break one value,
        // leaving the document itself perfectly good JSON.
        let mut document = created.theme.expect("valid");
        document
            .css_vars
            .insert("--background".into(), "hsl(var(--foreground))".into());
        let broken = serde_json::to_string_pretty(&document).expect("serializes");

        let theme = write("my-theme", &broken).await.expect("writes anyway");
        assert!(
            theme.theme.is_none(),
            "invalid theme must not be applicable"
        );
        assert!(!theme.issues.is_empty());
        assert_eq!(
            theme.label.as_deref(),
            Some("My Theme"),
            "a broken theme must still be nameable in the gallery"
        );

        // Still listed, so the gallery can show the user what to fix.
        let listed = list().await.expect("lists");
        assert_eq!(listed.len(), 1);
        assert!(listed[0].theme.is_none());
    }

    #[tokio::test]
    async fn a_file_that_is_not_json_reports_a_document_level_issue() {
        create_dracula("My Theme").await;
        let theme = write("my-theme", "{ nope").await.expect("writes anyway");
        assert!(theme.theme.is_none());
        assert_eq!(theme.label, None, "an unparseable file has no name to show");
        assert_eq!(theme.issues.len(), 1);
        assert_eq!(theme.issues[0].token, None);
    }

    #[tokio::test]
    async fn writing_or_deleting_an_unknown_theme_is_a_404() {
        assert!(write("nope", "{}").await.is_err());
        assert!(delete("nope").await.is_err());
    }

    #[tokio::test]
    async fn rejects_creating_an_invalid_theme() {
        let mut css_vars = dracula_css_vars();
        css_vars.remove("--background");
        let error = create()
            .label("Broken")
            .appearance(ThemeAppearance::Dark)
            .css_vars(css_vars)
            .xterm(dracula_xterm())
            .call()
            .await
            .expect_err("must reject");
        assert!(error.to_string().contains("--background"), "{error}");
    }

    /// The point of chrome being data: duplicating CadencR Dark has to produce a
    /// theme that still tucks into the rail and still draws segmented tabs, and
    /// the file has to say so in terms the user can then edit.
    #[tokio::test]
    async fn a_created_theme_keeps_the_chrome_it_was_duplicated_from() {
        let chrome = ThemeChrome {
            chassis: ThemeChassis::Rail,
            tabs: ThemeTabs::Segmented,
            texture: ThemeTexture {
                base: Some("#101319".into()),
                halos: vec![ThemeHalo {
                    color: "oklch(0.6 0.12 230 / 0.55)".into(),
                    size: 72.0,
                    x: 28.0,
                    y: 32.0,
                    blur: 80.0,
                    opacity: 0.56,
                    drift: 28.0,
                }],
                image: None,
                grain: Some(ThemeGrain {
                    color: "#9ea8c7".into(),
                    opacity: 0.36,
                    blend: ThemeBlend::Screen,
                    scale: 180.0,
                }),
                veil: true,
            },
        };
        let created = create()
            .label("Frosty")
            .appearance(ThemeAppearance::Dark)
            .css_vars(dracula_css_vars())
            .xterm(dracula_xterm())
            .chrome(chrome.clone())
            .call()
            .await
            .expect("creates");

        assert_eq!(created.theme.expect("valid").chrome, chrome);
        assert!(
            created.content.contains("\"chassis\": \"rail\""),
            "the file must spell the chrome out so it can be edited:\n{}",
            created.content
        );
    }

    /// A key `chrome` doesn't know fails the whole document, not just that
    /// field — so without recovering the label the gallery would fall back to
    /// showing the slug, and the theme's project would rename itself in the
    /// sidebar. A misspelling should cost you a message, not your theme's name.
    #[tokio::test]
    async fn a_document_that_would_not_parse_is_still_named() {
        let created = create_dracula("My Theme").await;
        let broken = created.content.replace("\"chassis\"", "\"chasis\"");

        let theme = write("my-theme", &broken).await.expect("writes anyway");

        assert!(theme.theme.is_none(), "an unknown key must not be applied");
        assert_eq!(theme.label.as_deref(), Some("My Theme"));
        assert_eq!(theme.issues.len(), 1);
        assert!(
            theme.issues[0].message.contains("chasis"),
            "{}",
            theme.issues[0].message
        );
    }

    /// The line that makes the file explain itself: an editor follows it to the
    /// schema in the same folder, and so can the agent that opens the theme.
    #[tokio::test]
    async fn a_created_theme_points_at_its_schema() {
        let created = create_dracula("My Theme").await;
        assert_eq!(
            created.theme.expect("valid").schema.as_deref(),
            Some(schema::SCHEMA_REFERENCE)
        );
        assert!(
            created.content.starts_with("{\n  \"$schema\":"),
            "it has to be the first thing read:\n{}",
            &created.content[..60]
        );
    }

    /// Nothing requires it, though: a file that never had the line, or whose
    /// author deleted it, is still a theme.
    #[tokio::test]
    async fn a_theme_without_the_schema_line_still_loads() {
        let created = create_dracula("My Theme").await;
        let mut document: serde_json::Value =
            serde_json::from_str(&created.content).expect("parses");
        document
            .as_object_mut()
            .expect("object")
            .remove("$schema")
            .expect("was written");

        let theme = write("my-theme", &document.to_string())
            .await
            .expect("writes");
        assert_eq!(theme.theme.expect("still valid").schema, None);
        assert!(theme.issues.is_empty());
    }

    /// A theme file written before chrome existed still has to load.
    #[tokio::test]
    async fn a_document_without_chrome_gets_the_plain_default() {
        let created = create_dracula("My Theme").await;
        let mut document: serde_json::Value =
            serde_json::from_str(&created.content).expect("parses");
        document
            .as_object_mut()
            .expect("object")
            .remove("chrome")
            .expect("chrome was written");

        let theme = write("my-theme", &document.to_string())
            .await
            .expect("writes");
        assert_eq!(
            theme.theme.expect("still valid").chrome,
            ThemeChrome::default()
        );
    }
}
