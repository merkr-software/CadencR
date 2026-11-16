//! Writes to a forge: merging, queueing, cancelling auto-merge.
//!
//! Kept apart from the read path in the parent module because the two want
//! opposite things from the transport. Reads are conditional and cached, and a
//! non-2xx is a failure to show; a write must never carry an `If-None-Match`
//! from an earlier read, and a 4xx is usually the forge explaining *why* it
//! refused ("Pull Request is not mergeable") — the user needs that sentence,
//! not an HTTP status line.

use reqwest::{RequestBuilder, StatusCode};
use serde::de::DeserializeOwned;
use serde_json::Value;

use super::{request_failure_message, truncated_detail, ForgeHttp};
use crate::domain::git::forge::provider::ForgeError;

/// What a forge answered to a write it accepted.
pub struct MutationResponse {
    pub status: StatusCode,
    /// `Null` for an empty body (`204 No Content`).
    pub body: Value,
}

impl ForgeHttp {
    pub fn put(&self, url: &str) -> RequestBuilder {
        self.client.put(url)
    }

    pub fn delete(&self, url: &str) -> RequestBuilder {
        self.client.delete(url)
    }

    /// Sends a write and returns the forge's answer. A 4xx becomes
    /// [`ForgeError::Refused`] carrying the forge's own explanation.
    pub async fn request_mutation(
        &self,
        builder: RequestBuilder,
    ) -> Result<MutationResponse, ForgeError> {
        let response = self.send_uncached(builder).await?;
        let status = response.status();
        let text = response
            .text()
            .await
            .map_err(|error| ForgeError::Http(format!("failed reading forge response: {error}")))?;
        if status.is_client_error() {
            return Err(ForgeError::Refused(
                forge_message(&text).unwrap_or_else(|| request_failure_message(status, &text)),
            ));
        }
        if !status.is_success() {
            return Err(ForgeError::Http(request_failure_message(status, &text)));
        }
        let body = if text.trim().is_empty() {
            Value::Null
        } else {
            serde_json::from_str(&text)
                .map_err(|error| ForgeError::Response(format!("invalid forge response: {error}")))?
        };
        Ok(MutationResponse { status, body })
    }

    /// A read where "not found" is an answer rather than a failure — whether a
    /// merge request is on a merge train, say. Uncached: these are rare, and a
    /// cached body for a resource that later 404s would be wrong either way.
    pub async fn request_optional_json<T: DeserializeOwned>(
        &self,
        builder: RequestBuilder,
    ) -> Result<Option<T>, ForgeError> {
        let response = self.send_uncached(builder).await?;
        let status = response.status();
        if status == StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            return Err(ForgeError::Http(request_failure_message(status, &body)));
        }
        response
            .json()
            .await
            .map(Some)
            .map_err(|error| ForgeError::Response(format!("invalid forge response: {error}")))
    }

    /// Sends without conditional headers, applying the same rate-limit and
    /// authentication policy as cached reads. Other statuses are the caller's.
    async fn send_uncached(
        &self,
        builder: RequestBuilder,
    ) -> Result<reqwest::Response, ForgeError> {
        let request = builder
            .build()
            .map_err(|error| ForgeError::Http(format!("invalid forge request: {error}")))?;
        let host = request.url().host_str().unwrap_or("forge").to_string();
        self.check_backoff(&host).await?;
        self.send_checked(request, host).await
    }
}

/// The human sentence inside a forge's error body. GitHub and GitLab answer
/// `{"message": …}` (GitLab sometimes with an array or object of messages);
/// Bitbucket nests it as `{"error": {"message": …}}`.
fn forge_message(body: &str) -> Option<String> {
    let value: Value = serde_json::from_str(body).ok()?;
    let message = value
        .get("error")
        .and_then(|error| error.get("message"))
        .or_else(|| value.get("message"))
        .or_else(|| value.get("error"))?;
    let text = match message {
        Value::String(text) => text.clone(),
        Value::Array(items) => items
            .iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>()
            .join("; "),
        Value::Object(fields) => fields
            .iter()
            .map(|(field, detail)| format!("{field}: {}", flatten(detail)))
            .collect::<Vec<_>>()
            .join("; "),
        _ => return None,
    };
    let text = truncated_detail(text.trim());
    (!text.is_empty()).then_some(text)
}

fn flatten(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Array(items) => items.iter().map(flatten).collect::<Vec<_>>().join(", "),
        other => other.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::forge_message;

    #[test]
    fn reads_each_forges_error_envelope() {
        assert_eq!(
            forge_message(r#"{"message":"Pull Request is not mergeable"}"#).as_deref(),
            Some("Pull Request is not mergeable")
        );
        assert_eq!(
            forge_message(r#"{"type":"error","error":{"message":"You can't merge"}}"#).as_deref(),
            Some("You can't merge")
        );
        assert_eq!(
            forge_message(r#"{"message":{"sha":["does not match"]}}"#).as_deref(),
            Some("sha: does not match")
        );
        assert_eq!(forge_message("<html>nope</html>"), None);
    }
}
