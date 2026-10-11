use super::{identity::valid_id, journal, PublicationOperation, PublicationOperationsPage};
use crate::{app_state::AppState, error::AppError};
use axum::{
    extract::{Path, Query},
    routing::get,
    Json, Router,
};
use serde::Deserialize;
use std::collections::BTreeSet;

#[derive(Deserialize, utoipa::IntoParams)]
#[into_params(parameter_in = Query)]
#[serde(deny_unknown_fields)]
pub struct PublicationOperationsQuery {
    pub limit: Option<usize>,
    pub cursor: Option<String>,
}

#[utoipa::path(get, path = "/api/projects/{id}/publication-operations/{operation_id}",
    params(("id" = i64, Path,), ("operation_id" = String, Path,)), responses((status=200, body=PublicationOperation), (status=404), (status=503)))]
pub async fn get_publication_operation_handler(
    Path((project_id, id)): Path<(i64, String)>,
) -> Result<Json<PublicationOperation>, AppError> {
    let root = journal::root(project_id)?;
    tokio::task::spawn_blocking(move || {
        let _lock = journal::lock().lock().map_err(|_| journal::storage())?;
        let operation = journal::read(&root, &id)?;
        if operation
            .as_ref()
            .is_some_and(|operation| operation.project_id != project_id)
        {
            return Err(journal::storage());
        }
        operation
            .map(Json)
            .ok_or_else(|| AppError::NotFound("publication operation not found".into()))
    })
    .await
    .map_err(|_| journal::storage())?
}

#[utoipa::path(get, path = "/api/projects/{id}/publication-operations", params(("id" = i64, Path,), PublicationOperationsQuery),
    responses((status=200, body=PublicationOperationsPage), (status=400), (status=503)))]
pub async fn list_publication_operations_handler(
    Path(project_id): Path<i64>,
    query: Result<Query<PublicationOperationsQuery>, axum::extract::rejection::QueryRejection>,
) -> Result<Json<PublicationOperationsPage>, AppError> {
    let Query(query) = query
        .map_err(|_| AppError::BadRequest("invalid publication operation pagination".into()))?;
    let limit = query.limit.unwrap_or(20);
    if !(1..=100).contains(&limit)
        || query
            .cursor
            .as_ref()
            .is_some_and(|cursor| !valid_id(cursor))
    {
        return Err(AppError::BadRequest(
            "invalid publication operation pagination".into(),
        ));
    }
    let root = journal::root(project_id)?;
    tokio::task::spawn_blocking(move || {
        let _lock = journal::lock().lock().map_err(|_| journal::storage())?;
        match std::fs::symlink_metadata(&root) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(Json(PublicationOperationsPage {
                    operations: Vec::new(),
                    next_cursor: None,
                }))
            }
            Err(_) => return Err(journal::storage()),
            Ok(_) => {}
        }
        journal::ensure_root(&root)?;
        let mut ids = BTreeSet::new();
        for entry in std::fs::read_dir(&root).map_err(|_| journal::storage())? {
            let name = entry.map_err(|_| journal::storage())?.file_name();
            let Some(id) = name.to_str().and_then(|name| name.strip_suffix(".json")) else {
                continue;
            };
            if !valid_id(id)
                || query
                    .cursor
                    .as_ref()
                    .is_some_and(|cursor| id <= cursor.as_str())
            {
                continue;
            }
            ids.insert(id.to_owned());
            if ids.len() > limit + 1 {
                ids.pop_last();
            }
        }
        let more = ids.len() > limit;
        let mut operations = Vec::with_capacity(limit);
        for id in ids.into_iter().take(limit) {
            let operation = journal::read(&root, &id)?.ok_or_else(journal::storage)?;
            if operation.project_id != project_id {
                return Err(journal::storage());
            }
            operations.push(operation);
        }
        let next_cursor = if more {
            operations.last().map(|value| value.operation_id.clone())
        } else {
            None
        };
        Ok(Json(PublicationOperationsPage {
            operations,
            next_cursor,
        }))
    })
    .await
    .map_err(|_| journal::storage())?
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/api/projects/{id}/publication-operations",
            get(list_publication_operations_handler),
        )
        .route(
            "/api/projects/{id}/publication-operations/{operation_id}",
            get(get_publication_operation_handler),
        )
}

#[cfg(test)]
mod tests {
    #[test]
    fn pagination_is_documented_as_query_not_path_parameters() {
        use utoipa::OpenApi as _;
        #[derive(utoipa::OpenApi)]
        #[openapi(paths(super::list_publication_operations_handler))]
        struct Api;
        let document = serde_json::to_value(Api::openapi()).unwrap();
        let parameters = document["paths"]["/api/projects/{id}/publication-operations"]["get"]
            ["parameters"]
            .as_array()
            .unwrap();
        for name in ["limit", "cursor"] {
            let parameter = parameters
                .iter()
                .find(|value| value["name"] == name)
                .unwrap();
            assert_eq!(parameter["in"], "query");
        }
    }
}
