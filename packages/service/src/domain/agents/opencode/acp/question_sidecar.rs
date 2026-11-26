use std::path::Path;
use std::time::Duration;

use serde_json::Value;
use tempfile::TempDir;
use tokio::time::sleep;

use crate::domain::agents::adapter::RuntimeError;

const DIRECTORY_QUERY: &str = "directory";
const DIRECTORY_HEADER: &str = "x-opencode-directory";
const QUESTION_REPLY_ACTION: &str = "reply";
const QUESTION_REJECT_ACTION: &str = "reject";
const QUESTION_LOOKUP_RETRIES: usize = 10;
const QUESTION_LOOKUP_DELAY: Duration = Duration::from_millis(100);
const QUESTION_HTTP_TIMEOUT: Duration = Duration::from_secs(2);

pub(super) struct QuestionSidecar {
    base_url: String,
    directory: String,
    http: reqwest::Client,
    _instructions_dir: Option<TempDir>,
}

impl QuestionSidecar {
    pub(super) fn new(port: u16, directory: &Path) -> Self {
        Self {
            base_url: format!("http://127.0.0.1:{port}"),
            directory: directory.to_string_lossy().to_string(),
            http: reqwest::Client::builder()
                .timeout(QUESTION_HTTP_TIMEOUT)
                .build()
                .unwrap_or_else(|_| reqwest::Client::new()),
            _instructions_dir: None,
        }
    }

    pub(super) fn with_instructions_dir(mut self, instructions_dir: Option<TempDir>) -> Self {
        self._instructions_dir = instructions_dir;
        self
    }

    pub(super) async fn reply_tool_call(
        &self,
        tool_call_id: &str,
        answers: Vec<Vec<String>>,
    ) -> Result<(), RuntimeError> {
        let question_id = self.find_question_id(tool_call_id).await?;
        self.post_question_action(&question_id, QUESTION_REPLY_ACTION, Some(answers))
            .await
    }

    pub(super) async fn reject_tool_call(&self, tool_call_id: &str) -> Result<(), RuntimeError> {
        let question_id = self.find_question_id(tool_call_id).await?;
        self.post_question_action(&question_id, QUESTION_REJECT_ACTION, None)
            .await
    }

    async fn find_question_id(&self, tool_call_id: &str) -> Result<String, RuntimeError> {
        let mut last_error = None;
        for attempt in 0..QUESTION_LOOKUP_RETRIES {
            match self.list_questions().await {
                Ok(questions) => {
                    if let Some(question_id) = question_id_for_tool_call(&questions, tool_call_id) {
                        return Ok(question_id);
                    }
                }
                Err(error) => last_error = Some(error.to_string()),
            }
            if attempt + 1 < QUESTION_LOOKUP_RETRIES {
                sleep(QUESTION_LOOKUP_DELAY).await;
            }
        }
        let suffix = last_error
            .as_deref()
            .map(|error| format!("; last lookup error: {error}"))
            .unwrap_or_default();
        Err(RuntimeError::new(format!(
            "OpenCode ACP question id not found for tool call {tool_call_id}{suffix}"
        )))
    }

    async fn list_questions(&self) -> Result<Value, RuntimeError> {
        let response = self
            .scoped(self.http.get(format!("{}/question", self.base_url)))
            .send()
            .await
            .map_err(|error| RuntimeError::new(format!("list ACP questions failed: {error}")))?;
        response_json(response, "list ACP questions").await
    }

    async fn post_question_action(
        &self,
        question_id: &str,
        action: &str,
        answers: Option<Vec<Vec<String>>>,
    ) -> Result<(), RuntimeError> {
        let url = format!("{}/question/{question_id}/{action}", self.base_url);
        let mut request = self.scoped(self.http.post(url));
        if let Some(answers) = answers {
            request = request.json(&serde_json::json!({ "answers": answers }));
        }
        let response = request.send().await.map_err(|error| {
            RuntimeError::new(format!("OpenCode ACP question {action} failed: {error}"))
        })?;
        ensure_success(response, "OpenCode ACP question response").await
    }

    fn scoped(&self, request: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        request
            .query(&[(DIRECTORY_QUERY, self.directory.as_str())])
            .header(DIRECTORY_HEADER, self.directory.as_str())
    }
}

async fn ensure_success(response: reqwest::Response, context: &str) -> Result<(), RuntimeError> {
    let status = response.status();
    if status.is_success() {
        return Ok(());
    }
    let body = response.text().await.map_err(|error| {
        RuntimeError::new(format!("{context} response body read failed: {error}"))
    })?;
    Err(RuntimeError::new(format!(
        "{context} returned HTTP {}: {body}",
        status.as_u16()
    )))
}

async fn response_json(response: reqwest::Response, context: &str) -> Result<Value, RuntimeError> {
    let status = response.status();
    let body = response.text().await.map_err(|error| {
        RuntimeError::new(format!("{context} response body read failed: {error}"))
    })?;
    if !status.is_success() {
        return Err(RuntimeError::new(format!(
            "{context} returned HTTP {}: {body}",
            status.as_u16()
        )));
    }
    if body.trim().is_empty() {
        return Ok(Value::Null);
    }
    serde_json::from_str(&body)
        .map_err(|error| RuntimeError::new(format!("{context} returned invalid JSON: {error}")))
}

pub(super) fn question_id_for_tool_call(questions: &Value, tool_call_id: &str) -> Option<String> {
    questions.as_array()?.iter().find_map(|question| {
        let call_id = question
            .get("tool")
            .and_then(|tool| tool.get("callID").or_else(|| tool.get("callId")))
            .and_then(Value::as_str)?;
        if call_id == tool_call_id {
            question
                .get("id")
                .or_else(|| question.get("requestID"))
                .or_else(|| question.get("request_id"))
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
        } else {
            None
        }
    })
}

#[cfg(test)]
mod tests {
    use super::{question_id_for_tool_call, QuestionSidecar};
    use axum::body::Bytes;
    use axum::extract::State;
    use axum::http::StatusCode;
    use axum::routing::{get, post};
    use axum::Router;
    use serde_json::json;
    use std::path::Path;
    use std::sync::{Arc, Mutex};
    use tokio::net::TcpListener;

    #[derive(Default)]
    struct Calls {
        requests: Vec<String>,
    }

    async fn question_server(status: StatusCode) -> (u16, Arc<Mutex<Calls>>) {
        let calls = Arc::new(Mutex::new(Calls::default()));
        let state = Arc::clone(&calls);
        let app = Router::new()
            .route("/question", get(list_questions))
            .route("/question/{id}/reply", post(reply_question))
            .route("/question/{id}/reject", post(reject_question))
            .with_state((state, status));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        (port, calls)
    }

    async fn list_questions(
        State((calls, status)): State<(Arc<Mutex<Calls>>, StatusCode)>,
    ) -> (StatusCode, String) {
        calls
            .lock()
            .unwrap()
            .requests
            .push("GET /question".to_string());
        if !status.is_success() {
            return (status, "nope".to_string());
        }
        (
            status,
            json!([{ "id": "que_1", "tool": { "callID": "call_1" } }]).to_string(),
        )
    }

    async fn reply_question(
        State((calls, status)): State<(Arc<Mutex<Calls>>, StatusCode)>,
        body: Bytes,
    ) -> StatusCode {
        calls
            .lock()
            .unwrap()
            .requests
            .push(format!("POST reply {}", String::from_utf8_lossy(&body)));
        status
    }

    async fn reject_question(
        State((calls, status)): State<(Arc<Mutex<Calls>>, StatusCode)>,
    ) -> StatusCode {
        calls
            .lock()
            .unwrap()
            .requests
            .push("POST reject".to_string());
        status
    }

    #[test]
    fn finds_question_id_by_acp_tool_call_id() {
        let questions = json!([
            {
                "id": "que_1",
                "sessionID": "ses_1",
                "tool": {
                    "messageID": "msg_1",
                    "callID": "call_1"
                },
                "questions": [{ "question": "Pick one" }]
            }
        ]);

        assert_eq!(
            question_id_for_tool_call(&questions, "call_1").as_deref(),
            Some("que_1")
        );
    }

    #[test]
    fn accepts_alternate_question_and_call_id_fields() {
        let questions = json!([
            {
                "request_id": "que_snake",
                "tool": { "callId": "call_snake" },
                "questions": [{ "question": "Pick one" }]
            },
            {
                "requestID": "que_camel",
                "tool": { "callID": "call_camel" },
                "questions": [{ "question": "Pick two" }]
            }
        ]);

        assert_eq!(
            question_id_for_tool_call(&questions, "call_snake").as_deref(),
            Some("que_snake")
        );
        assert_eq!(
            question_id_for_tool_call(&questions, "call_camel").as_deref(),
            Some("que_camel")
        );
    }

    #[tokio::test]
    async fn reply_tool_call_uses_question_lookup_and_reply_endpoint() {
        let (port, calls) = question_server(StatusCode::OK).await;
        let sidecar = QuestionSidecar::new(port, Path::new("/tmp/project"));

        sidecar
            .reply_tool_call("call_1", vec![vec!["yes".to_string()]])
            .await
            .unwrap();

        let calls = &calls.lock().unwrap().requests;
        assert!(calls.iter().any(|call| call == "GET /question"));
        assert!(calls
            .iter()
            .any(|call| call.contains("POST reply") && call.contains("\"yes\"")));
    }

    #[tokio::test]
    async fn reject_tool_call_uses_question_lookup_and_reject_endpoint() {
        let (port, calls) = question_server(StatusCode::OK).await;
        let sidecar = QuestionSidecar::new(port, Path::new("/tmp/project"));

        sidecar.reject_tool_call("call_1").await.unwrap();

        assert!(calls
            .lock()
            .unwrap()
            .requests
            .iter()
            .any(|call| call == "POST reject"));
    }

    #[tokio::test]
    async fn non_success_question_response_is_surfaced() {
        let (port, _calls) = question_server(StatusCode::INTERNAL_SERVER_ERROR).await;
        let sidecar = QuestionSidecar::new(port, Path::new("/tmp/project"));

        let error = sidecar
            .reply_tool_call("call_1", vec![vec!["yes".to_string()]])
            .await
            .unwrap_err();

        assert!(error.to_string().contains("HTTP 500"));
    }
}
