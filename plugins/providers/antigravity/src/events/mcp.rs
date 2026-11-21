use std::collections::HashMap;

use serde_json::{json, Map, Value};

#[derive(Default)]
pub(super) struct SessionServers {
    requests: HashMap<String, ServerRequest>,
    sessions: HashMap<String, Vec<String>>,
}

enum ServerRequest {
    Open {
        session_id: Option<String>,
        names: Vec<String>,
    },
    Close(String),
}

impl SessionServers {
    pub(super) fn observe_request(&mut self, message: &Value) {
        let Some(method) = message.get("method").and_then(Value::as_str) else {
            return;
        };
        if method == "$/cancel_request" {
            if let Some(id) = message.pointer("/params/requestId") {
                self.requests.remove(&id.to_string());
            }
            return;
        }
        let Some(id) = message
            .get("id")
            .filter(|id| id.is_string() || id.is_number())
        else {
            return;
        };
        let session_id = message.pointer("/params/sessionId").and_then(Value::as_str);
        let request = match method {
            "session/new" | "session/load" | "session/resume" => ServerRequest::Open {
                session_id: session_id.map(ToOwned::to_owned),
                names: server_names(message.pointer("/params/mcpServers")),
            },
            "session/close" => {
                let Some(session_id) = session_id else {
                    return;
                };
                ServerRequest::Close(session_id.to_owned())
            }
            _ => return,
        };
        self.requests.insert(id.to_string(), request);
    }

    pub(super) fn observe_response(&mut self, message: &Value) {
        let Some(request) = message
            .get("id")
            .and_then(|id| self.requests.remove(&id.to_string()))
        else {
            return;
        };
        let Some(result) = message.get("result") else {
            return;
        };
        match request {
            ServerRequest::Open { session_id, names } => {
                let id = result
                    .get("sessionId")
                    .and_then(Value::as_str)
                    .or(session_id.as_deref());
                if let Some(id) = id {
                    self.sessions.insert(id.to_owned(), names);
                }
            }
            ServerRequest::Close(id) => {
                self.sessions.remove(&id);
            }
        }
    }

    pub(super) fn for_params(&self, params: Option<&Value>) -> &[String] {
        params
            .and_then(|params| params.get("sessionId"))
            .and_then(Value::as_str)
            .and_then(|id| self.sessions.get(id))
            .map(Vec::as_slice)
            .unwrap_or_default()
    }
}

fn server_names(servers: Option<&Value>) -> Vec<String> {
    let mut names = servers
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|server| server.get("name").and_then(Value::as_str))
        .filter(|name| !name.is_empty() && !name.contains("__"))
        .map(ToOwned::to_owned)
        .collect::<Vec<_>>();
    names.sort_unstable();
    names.dedup();
    names
}

/// agy flattens the configured server and tool with underscores. A single
/// matching configured name is necessary to disambiguate that separator.
pub(super) fn normalize_call(call: &mut Map<String, Value>, name: &str, servers: &[String]) {
    let Some(flattened) = name.strip_prefix("mcp_") else {
        return;
    };
    let mut matches = servers.iter().filter_map(|server| {
        let tool = flattened.strip_prefix(server)?.strip_prefix('_')?;
        (!tool.is_empty()).then_some((server, tool))
    });
    let Some((server, tool)) = matches.next() else {
        return;
    };
    if matches.next().is_some() {
        return;
    }
    let arguments = call
        .remove("rawInput")
        .filter(|args| !args.is_null())
        .or_else(|| call.get("args").cloned())
        .unwrap_or(Value::Null);
    super::tools::set_name(call, &format!("mcp__{server}__{tool}"));
    call.insert(
        "rawInput".to_owned(),
        json!({"server":server,"tool":tool,"arguments":arguments}),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mcp_identity_is_scoped_to_successful_session_setup() {
        let mut state = SessionServers::default();
        let request = json!({"id":1,"method":"session/new","params":{"mcpServers":[{"name":"fixture_server"}]}});
        let params = json!({"sessionId":"s"});
        state.observe_request(&request);
        assert!(state.for_params(Some(&params)).is_empty());
        state.observe_response(&json!({"id":"1","result":{"sessionId":"s"}}));
        assert!(state.for_params(Some(&params)).is_empty());
        state.observe_response(&json!({"id":1,"result":{"sessionId":"s"}}));
        assert_eq!(state.for_params(Some(&params)), ["fixture_server"]);

        let close = json!({"id":2,"method":"session/close","params":params});
        state.observe_request(&close);
        state.observe_response(&json!({"id":2,"result":{}}));
        assert!(state.for_params(close.get("params")).is_empty());
    }

    #[test]
    fn a_cancelled_setup_does_not_retain_or_apply_stale_server_names() {
        let mut state = SessionServers::default();
        state.observe_request(
            &json!({"id":"1","method":"session/new","params":{"mcpServers":[{"name":"fixture"}]}}),
        );
        state.observe_request(&json!({"method":"$/cancel_request","params":{"requestId":"1"}}));
        assert!(state.requests.is_empty());
        state.observe_response(&json!({"id":"1","result":{"sessionId":"s"}}));
        assert!(state.for_params(Some(&json!({"sessionId":"s"}))).is_empty());
    }

    #[test]
    fn keeps_native_names_when_an_mcp_prefix_is_unavailable_or_ambiguous() {
        let native = "mcp_fixture_server_check";
        let original = json!({"name":native,"rawInput":{"message":"fixture"}});
        for servers in [vec![], vec!["fixture".into(), "fixture_server".into()]] {
            let mut call = original.as_object().unwrap().clone();
            normalize_call(&mut call, native, &servers);
            assert_eq!(Value::Object(call), original);
        }
        let mut call = original.as_object().unwrap().clone();
        normalize_call(&mut call, native, &["fixture_server".into()]);
        assert_eq!(call["name"], "mcp__fixture_server__check");
        assert_eq!(
            call["rawInput"],
            json!({"server":"fixture_server","tool":"check","arguments":{"message":"fixture"}})
        );
    }
}
