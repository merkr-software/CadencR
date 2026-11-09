//! Settings-form values a tab declares in `configuration`.
//!
//! Values are stored as JSON text, globally or per project, in
//! `plugin_tab_config`. Secrets are stored the same way, flagged `is_secret`,
//! and never leave the service through the host API: a set secret reads
//! `{ "is_set": true }`. The flag is kept with the value, so a manifest that
//! re-declares a secret as a plain field cannot read it back.
//! [`secret_value`] is the one way to read them, for server-side substitution.

use std::collections::BTreeMap;

use axum::http::StatusCode;
use cadencr_plugin_core::tab::{TabConfigField, TabConfigFieldType, TabConfigScope, TabManifest};
use serde_json::{json, Value};
use sqlx::SqlitePool;

use super::models::PluginTabConfiguration;
use crate::error::AppError;

/// Stored JSON values are small form inputs, not blobs.
const MAX_VALUE_BYTES: usize = 16 * 1024;

type Values = BTreeMap<String, Value>;

/// A stored value and whether it was saved as a secret.
struct Stored {
    value: Value,
    secret: bool,
}

type StoredValues = BTreeMap<String, Stored>;

/// The form for `project_id` (or global only). Secrets are masked.
pub async fn read(
    pool: &SqlitePool,
    plugin_id: &str,
    manifest: &TabManifest,
    project_id: Option<i64>,
) -> Result<PluginTabConfiguration, AppError> {
    let (global, project) = stored(pool, plugin_id, project_id).await?;
    Ok(PluginTabConfiguration {
        fields: manifest.configuration.clone(),
        global: mask(manifest, global),
        project: project_id.map(|_| mask(manifest, project)),
    })
}

/// Apply `values` at `project_id` (global when `None`). `null` removes a
/// value. Every key must be a declared field of the matching scope and every
/// value must fit its type; nothing is written unless all of them do.
pub async fn write(
    pool: &SqlitePool,
    plugin_id: &str,
    manifest: &TabManifest,
    project_id: Option<i64>,
    values: &Values,
) -> Result<(), AppError> {
    // Not `with_capacity(values.len())`: the map is request-sized.
    let mut rows = Vec::new();
    for (key, value) in values {
        let field = declared(manifest, key)?;
        check_scope(field, project_id)?;
        if value.is_null() {
            rows.push((key.as_str(), None));
            continue;
        }
        let text = value.to_string();
        if !field.accepts(value) || text.len() > MAX_VALUE_BYTES {
            return Err(invalid(format!(
                "`{key}` must be a {:?} value of at most {} KiB",
                field.field_type,
                MAX_VALUE_BYTES / 1024
            )));
        }
        let secret = field.field_type == TabConfigFieldType::Secret;
        rows.push((key.as_str(), Some((text, secret))));
    }
    // Two partial unique indexes back the two row kinds, and an upsert's
    // conflict target must name the matching one.
    let upsert = if project_id.is_none() {
        "INSERT INTO plugin_tab_config (plugin_id, project_id, key, value, is_secret) \
         VALUES (?, ?, ?, ?, ?) ON CONFLICT (plugin_id, key) WHERE project_id IS NULL \
         DO UPDATE SET value = excluded.value, is_secret = excluded.is_secret, \
         updated_at = CURRENT_TIMESTAMP"
    } else {
        "INSERT INTO plugin_tab_config (plugin_id, project_id, key, value, is_secret) \
         VALUES (?, ?, ?, ?, ?) ON CONFLICT (plugin_id, project_id, key) \
         WHERE project_id IS NOT NULL \
         DO UPDATE SET value = excluded.value, is_secret = excluded.is_secret, \
         updated_at = CURRENT_TIMESTAMP"
    };
    let mut tx = pool.begin().await?;
    for (key, text) in rows {
        let query = match text {
            Some((text, secret)) => sqlx::query(upsert)
                .bind(plugin_id)
                .bind(project_id)
                .bind(key)
                .bind(text)
                .bind(secret),
            None => sqlx::query(
                "DELETE FROM plugin_tab_config WHERE plugin_id = ? AND project_id IS ? AND key = ?",
            )
            .bind(plugin_id)
            .bind(project_id)
            .bind(key),
        };
        query.execute(&mut *tx).await?;
    }
    tx.commit().await?;
    Ok(())
}

/// Non-secret values for `project_id`: project over global over declared
/// defaults. Secrets (declared or saved as one) and undeclared stored keys are
/// omitted.
pub async fn resolved_values(
    pool: &SqlitePool,
    plugin_id: &str,
    manifest: &TabManifest,
    project_id: i64,
) -> Result<Values, AppError> {
    let (global, project) = stored(pool, plugin_id, Some(project_id)).await?;
    let mut resolved = Values::new();
    for field in &manifest.configuration {
        if field.field_type == TabConfigFieldType::Secret {
            continue;
        }
        let value = plain(&project, &field.key)
            .or_else(|| plain(&global, &field.key))
            .or(field.default.as_ref());
        if let Some(value) = value.filter(|value| field.accepts(value)) {
            resolved.insert(field.key.clone(), value.clone());
        }
    }
    Ok(resolved)
}

/// The stored value of `key` unless it was saved as a secret.
fn plain<'a>(values: &'a StoredValues, key: &str) -> Option<&'a Value> {
    values
        .get(key)
        .filter(|stored| !stored.secret)
        .map(|stored| &stored.value)
}

/// The plaintext of secret `key` for `project_id` (project over global), for
/// server-side substitution only. `None` when unset or not a declared secret.
pub async fn secret_value(
    pool: &SqlitePool,
    plugin_id: &str,
    manifest: &TabManifest,
    project_id: i64,
    key: &str,
) -> Result<Option<String>, AppError> {
    let declared_secret = manifest
        .configuration
        .iter()
        .any(|field| field.key == key && field.field_type == TabConfigFieldType::Secret);
    if !declared_secret {
        return Ok(None);
    }
    let text: Option<String> = sqlx::query_scalar(
        "SELECT value FROM plugin_tab_config WHERE plugin_id = ? AND key = ? \
         AND (project_id = ? OR project_id IS NULL) ORDER BY project_id IS NULL LIMIT 1",
    )
    .bind(plugin_id)
    .bind(key)
    .bind(project_id)
    .fetch_optional(pool)
    .await?;
    let Some(text) = text else {
        return Ok(None);
    };
    Ok(parse_stored(key, &text)?.as_str().map(str::to_string))
}

/// The stored global values and, when `project_id` is given, that project's,
/// in one query.
async fn stored(
    pool: &SqlitePool,
    plugin_id: &str,
    project_id: Option<i64>,
) -> Result<(StoredValues, StoredValues), AppError> {
    let rows: Vec<(Option<i64>, String, String, bool)> = sqlx::query_as(
        "SELECT project_id, key, value, is_secret FROM plugin_tab_config \
         WHERE plugin_id = ? AND (project_id IS NULL OR project_id = ?)",
    )
    .bind(plugin_id)
    .bind(project_id)
    .fetch_all(pool)
    .await?;
    let (mut global, mut project) = (StoredValues::new(), StoredValues::new());
    for (row_project, key, text, secret) in rows {
        let value = Stored {
            value: parse_stored(&key, &text)?,
            secret,
        };
        match row_project {
            None => global.insert(key, value),
            Some(_) => project.insert(key, value),
        };
    }
    Ok((global, project))
}

fn parse_stored(key: &str, text: &str) -> Result<Value, AppError> {
    serde_json::from_str(text).map_err(|error| {
        AppError::internal(format!(
            "stored custom tab setting `{key}` is not JSON: {error}"
        ))
    })
}

/// Declared, non-secret values as stored; set secrets (declared or saved as
/// one) become `{ "is_set": true }`.
fn mask(manifest: &TabManifest, stored: StoredValues) -> Values {
    stored
        .into_iter()
        .filter_map(|(key, stored)| {
            let field = manifest
                .configuration
                .iter()
                .find(|field| field.key == key)?;
            Some(
                if stored.secret || field.field_type == TabConfigFieldType::Secret {
                    (key, json!({ "is_set": true }))
                } else {
                    (key, stored.value)
                },
            )
        })
        .collect()
}

fn declared<'a>(manifest: &'a TabManifest, key: &str) -> Result<&'a TabConfigField, AppError> {
    manifest
        .configuration
        .iter()
        .find(|field| field.key == key)
        .ok_or_else(|| invalid(format!("`{key}` is not a declared setting")))
}

fn check_scope(field: &TabConfigField, project_id: Option<i64>) -> Result<(), AppError> {
    match (field.scope, project_id) {
        (TabConfigScope::Global, None) | (TabConfigScope::Project, Some(_)) => Ok(()),
        (TabConfigScope::Global, Some(_)) => Err(invalid(format!(
            "`{}` is a global setting; omit project_id",
            field.key
        ))),
        (TabConfigScope::Project, None) => Err(invalid(format!(
            "`{}` is a per-project setting; pass project_id",
            field.key
        ))),
    }
}

fn invalid(message: String) -> AppError {
    AppError::coded(
        StatusCode::BAD_REQUEST,
        "PLUGIN_TAB_CONFIG_INVALID",
        message,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::plugin_tabs::test_support::{insert_project, pool};

    fn manifest() -> TabManifest {
        serde_json::from_value(cadencr_plugin_core::tab::test_support::manifest_json_for(
            "graph",
            json!({}),
        ))
        .unwrap()
    }

    #[tokio::test]
    async fn secrets_are_masked_and_only_readable_server_side() {
        let pool = pool().await;
        let manifest = manifest();
        let values = Values::from([
            ("gitlab_url".into(), json!("https://gitlab.example.com")),
            ("gitlab_token".into(), json!("glpat-secret")),
        ]);
        write(&pool, "graph", &manifest, None, &values)
            .await
            .unwrap();
        let form = read(&pool, "graph", &manifest, None).await.unwrap();
        assert_eq!(form.global["gitlab_token"], json!({ "is_set": true }));
        assert_eq!(
            form.global["gitlab_url"],
            json!("https://gitlab.example.com")
        );
        assert!(!serde_json::to_string(&form)
            .unwrap()
            .contains("glpat-secret"));
        let project = insert_project(&pool, "p").await;
        assert_eq!(
            secret_value(&pool, "graph", &manifest, project, "gitlab_token")
                .await
                .unwrap()
                .as_deref(),
            Some("glpat-secret")
        );
        assert_eq!(
            secret_value(&pool, "graph", &manifest, project, "gitlab_url")
                .await
                .unwrap(),
            None,
            "non-secrets are not readable through the secret path"
        );
        write(
            &pool,
            "graph",
            &manifest,
            None,
            &Values::from([("gitlab_token".into(), Value::Null)]),
        )
        .await
        .unwrap();
        assert!(!read(&pool, "graph", &manifest, None)
            .await
            .unwrap()
            .global
            .contains_key("gitlab_token"));
    }

    #[tokio::test]
    async fn a_secret_redeclared_as_plain_stays_hidden() {
        let pool = pool().await;
        let manifest = manifest();
        write(
            &pool,
            "graph",
            &manifest,
            None,
            &Values::from([("gitlab_token".into(), json!("glpat-secret"))]),
        )
        .await
        .unwrap();
        let mut widened = manifest.clone();
        for field in &mut widened.configuration {
            if field.key == "gitlab_token" {
                field.field_type = TabConfigFieldType::String;
            }
        }
        let project = insert_project(&pool, "p").await;
        let resolved = resolved_values(&pool, "graph", &widened, project)
            .await
            .unwrap();
        assert!(!resolved.contains_key("gitlab_token"));
        let form = read(&pool, "graph", &widened, None).await.unwrap();
        assert_eq!(form.global["gitlab_token"], json!({ "is_set": true }));
        assert_eq!(
            secret_value(&pool, "graph", &widened, project, "gitlab_token")
                .await
                .unwrap(),
            None
        );
    }

    #[tokio::test]
    async fn scope_type_and_key_are_enforced_atomically() {
        let pool = pool().await;
        let manifest = manifest();
        let project = insert_project(&pool, "p").await;
        for (project_id, values) in [
            (
                Some(project),
                Values::from([("gitlab_url".into(), json!("x"))]),
            ),
            (None, Values::from([("group".into(), json!("directory"))])),
            (
                Some(project),
                Values::from([("group".into(), json!("nope"))]),
            ),
            (None, Values::from([("unknown".into(), json!("x"))])),
            (
                None,
                Values::from([("gitlab_url".into(), json!("x".repeat(17 * 1024)))]),
            ),
        ] {
            let error = write(&pool, "graph", &manifest, project_id, &values)
                .await
                .unwrap_err();
            assert!(matches!(
                error,
                AppError::Coded {
                    code: "PLUGIN_TAB_CONFIG_INVALID",
                    ..
                }
            ));
        }
        let mixed = Values::from([
            ("gitlab_url".into(), json!("https://ok")),
            ("unknown".into(), json!("x")),
        ]);
        assert!(write(&pool, "graph", &manifest, None, &mixed)
            .await
            .is_err());
        assert!(read(&pool, "graph", &manifest, None)
            .await
            .unwrap()
            .global
            .is_empty());
    }

    #[tokio::test]
    async fn resolution_prefers_project_then_global_then_default() {
        let pool = pool().await;
        let manifest = manifest();
        let project = insert_project(&pool, "p").await;
        let defaults = resolved_values(&pool, "graph", &manifest, project)
            .await
            .unwrap();
        assert_eq!(
            defaults,
            Values::from([("group".into(), json!("directory"))])
        );
        write(
            &pool,
            "graph",
            &manifest,
            Some(project),
            &Values::from([("group".into(), json!("extension"))]),
        )
        .await
        .unwrap();
        write(
            &pool,
            "graph",
            &manifest,
            None,
            &Values::from([("gitlab_url".into(), json!("https://g"))]),
        )
        .await
        .unwrap();
        let resolved = resolved_values(&pool, "graph", &manifest, project)
            .await
            .unwrap();
        assert_eq!(resolved["group"], json!("extension"));
        assert_eq!(resolved["gitlab_url"], json!("https://g"));
        let form = read(&pool, "graph", &manifest, Some(project))
            .await
            .unwrap();
        assert_eq!(form.project.unwrap()["group"], json!("extension"));
    }
}
