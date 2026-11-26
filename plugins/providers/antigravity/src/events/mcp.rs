use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, OnceLock};

use serde_json::{json, Map, Value};

#[derive(Default)]
pub(super) struct SessionServers {
    requests: HashMap<String, ServerRequest>,
    sessions: HashMap<String, SessionInventory>,
    pub(super) home: Option<PathBuf>,
}

#[derive(Default)]
struct SessionInventory {
    names: Vec<String>,
    native: Arc<OnceLock<HashSet<String>>>,
}

enum ServerRequest {
    Open {
        session_id: Option<String>,
        inventory: SessionInventory,
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
            "session/new" | "session/load" | "session/resume" => {
                if let Some(id) = session_id {
                    self.sessions.remove(id);
                    self.requests.retain(|_, pending| !matches!(pending, ServerRequest::Open {session_id: Some(other), ..} if other == id));
                }
                let names = server_names(message.pointer("/params/mcpServers"));
                let native = Arc::new(OnceLock::new());
                if names.iter().any(|name| {
                    matches!(
                        name.as_str(),
                        "cadencr-browser" | "cadencr-project" | "cadencr-workspace"
                    )
                }) {
                    if let (Some(home), Some(cwd)) = (
                        self.home.clone(),
                        message.pointer("/params/cwd").and_then(Value::as_str),
                    ) {
                        let result = Arc::clone(&native);
                        let cwd = PathBuf::from(cwd);
                        tokio::task::spawn_blocking(move || {
                            match crate::mcp_inventory::configured_servers(&cwd, &home) {
                                Ok(Some(names)) => {
                                    result.get_or_init(|| names);
                                }
                                Ok(None) => {}
                                Err(error) => eprintln!(
                                    "Could not verify native Antigravity MCP inventory: {error}"
                                ),
                            }
                        });
                    }
                }
                ServerRequest::Open {
                    session_id: session_id.map(ToOwned::to_owned),
                    inventory: SessionInventory { names, native },
                }
            }
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
            ServerRequest::Open {
                session_id,
                inventory,
            } => {
                let id = result
                    .get("sessionId")
                    .and_then(Value::as_str)
                    .or(session_id.as_deref());
                if let Some(id) = id {
                    self.sessions.insert(id.to_owned(), inventory);
                }
            }
            ServerRequest::Close(id) => {
                self.sessions.remove(&id);
            }
        }
    }

    pub(super) fn native(&self, params: &Value) -> Option<&HashSet<String>> {
        self.sessions
            .get(params.get("sessionId")?.as_str()?)?
            .native
            .get()
    }

    pub(super) fn for_params(&self, params: Option<&Value>) -> &[String] {
        params
            .and_then(|params| params.get("sessionId"))
            .and_then(Value::as_str)
            .and_then(|id| self.sessions.get(id))
            .map(|inventory| inventory.names.as_slice())
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

pub(super) fn approval_name(
    call: &Value,
    servers: &[String],
    foreign: Option<&HashSet<String>>,
) -> Option<String> {
    let name = super::tools::call_name(call.as_object()?)?;
    if ["name", "toolName"]
        .iter()
        .filter_map(|key| call.get(key))
        .any(|field| field.as_str() != Some(name))
    {
        return None;
    }
    if call["kind"] != "other"
        || call["title"].as_str()? != format!("Run {name}")
        || call
            .get("content")
            .is_some_and(|content| !content.as_array().is_some_and(Vec::is_empty))
    {
        return None;
    }
    let raw = name.strip_prefix("mcp_")?;
    let normalized = normalized_name(raw);
    let foreign = foreign?;
    let (server, tool) = attached_tool(raw, servers)?;
    if foreign
        .iter()
        .chain(servers.iter().filter(|other| other.as_str() != server))
        .any(|name| {
            normalized
                .strip_prefix(&normalized_name(name))
                .is_some_and(|suffix| suffix.starts_with('_'))
        })
    {
        return None;
    }
    Some(format!("mcp__{server}__{tool}"))
}

fn attached_tool<'a, 'b>(raw: &'a str, servers: &'b [String]) -> Option<(&'b str, &'a str)> {
    let mut matches = servers.iter().filter_map(|name| {
        let tool = raw.strip_prefix(name)?.strip_prefix('_')?;
        (!tool.is_empty()).then_some((name.as_str(), tool))
    });
    let identity = matches.next()?;
    matches.next().is_none().then_some(identity)
}

fn normalized_name(name: &str) -> String {
    name.chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() {
                ch.to_ascii_lowercase()
            } else {
                '_'
            }
        })
        .collect()
}

/// agy flattens the configured server and tool with underscores. A single
/// matching configured name is necessary to disambiguate that separator.
pub(super) fn normalize_call(call: &mut Map<String, Value>, name: &str, servers: &[String]) {
    let Some(flattened) = name.strip_prefix("mcp_") else {
        return;
    };
    let Some((server, tool)) = attached_tool(flattened, servers) else {
        return;
    };
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
    fn only_unambiguous_native_mcp_calls_can_be_attributed_to_an_attachment() {
        let call = json!({"toolName":"mcp_cadencr-project_project_list_sessions","kind":"other","title":"Run mcp_cadencr-project_project_list_sessions"});
        let attached = vec!["cadencr-project".into()];
        let foreign = HashSet::new();
        assert_eq!(
            approval_name(&call, &attached, Some(&foreign)).as_deref(),
            Some("mcp__cadencr-project__project_list_sessions")
        );
        assert!(approval_name(&call, &attached, None).is_none());
        for collision in [
            "Cadencr.Project",
            "cadencr-project",
            "cadencr-project_project",
        ] {
            assert!(
                approval_name(&call, &attached, Some(&HashSet::from([collision.into()]))).is_none()
            );
        }
        let conflicting =
            json!({"toolName":"mcp_cadencr-project_project_list_sessions","name":"run_command"});
        assert!(approval_name(&conflicting, &attached, Some(&foreign)).is_none());
    }

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
