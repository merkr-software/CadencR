//! End-to-end: the built connector proxies a scripted fake `agent` CLI
//! (`tests/fixtures/fake_agent.py`) while this test plays Cadencr's host.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};

const CONNECTOR: &str = env!("CARGO_BIN_EXE_cadencr-cursor-provider");
const STEP_TIMEOUT: Duration = Duration::from_secs(20);

fn fake_agent() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/fake_agent.py")
}

fn connector(log: &Path) -> Command {
    let mut command = Command::new(CONNECTOR);
    command
        .env("CADENCR_CURSOR_COMMAND", fake_agent())
        .env("FAKE_AGENT_LOG", log)
        .kill_on_drop(true);
    command
}

struct Host {
    process: Child,
    stdin: Option<ChildStdin>,
    lines: Lines<BufReader<ChildStdout>>,
    next_id: u64,
    /// Every notification and connector-initiated request, in arrival order.
    seen: Vec<Value>,
}

type Responder<'a> = &'a mut dyn FnMut(&Value) -> Value;

impl Host {
    fn spawn(log: &Path) -> Self {
        let mut process = connector(log)
            .args(["run", "--protocol", "acp-v1"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .expect("spawn connector");
        let stdin = process.stdin.take();
        let lines = BufReader::new(process.stdout.take().unwrap()).lines();
        Self {
            process,
            stdin,
            lines,
            next_id: 1,
            seen: Vec::new(),
        }
    }

    async fn send(&mut self, message: Value) {
        let stdin = self.stdin.as_mut().expect("stdin open");
        stdin
            .write_all(format!("{message}\n").as_bytes())
            .await
            .unwrap();
        stdin.flush().await.unwrap();
    }

    async fn next_message(&mut self) -> Value {
        let line = tokio::time::timeout(STEP_TIMEOUT, self.lines.next_line())
            .await
            .expect("connector answered in time")
            .unwrap()
            .expect("connector stdout open");
        serde_json::from_str(&line).unwrap_or_else(|_| panic!("non-JSON stdout: {line}"))
    }

    /// Send a request, answering connector→host requests with `respond`.
    async fn request_with(&mut self, method: &str, params: Value, respond: Responder<'_>) -> Value {
        let id = self.next_id;
        self.next_id += 1;
        self.send(json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }))
            .await;
        loop {
            let message = self.next_message().await;
            if message.get("method").is_none() && message["id"] == json!(id) {
                return message;
            }
            if message.get("id").is_some() && message.get("method").is_some() {
                let result = respond(&message);
                let reply = json!({ "jsonrpc": "2.0", "id": message["id"], "result": result });
                self.send(reply).await;
            }
            self.seen.push(message);
        }
    }

    async fn request(&mut self, method: &str, params: Value) -> Value {
        self.request_with(method, params, &mut |message| {
            panic!("unexpected connector request {message}")
        })
        .await
    }

    fn take_seen(&mut self) -> Vec<Value> {
        std::mem::take(&mut self.seen)
    }
}

fn agent_log(path: &Path) -> Vec<Value> {
    std::fs::read_to_string(path)
        .unwrap_or_default()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

fn received(log: &[Value], method: &str) -> Vec<Value> {
    log.iter()
        .filter(|entry| entry["event"] == "recv" && entry["msg"]["method"] == method)
        .map(|entry| entry["msg"]["params"].clone())
        .collect()
}

fn acp_spawns(log: &[Value]) -> Vec<Vec<String>> {
    log.iter()
        .filter(|entry| entry["event"] == "spawn")
        .filter_map(|entry| {
            let argv: Vec<String> = serde_json::from_value(entry["argv"].clone()).ok()?;
            (argv.last().map(String::as_str) == Some("acp")).then_some(argv)
        })
        .collect()
}

fn updates_of<'a>(seen: &'a [Value], kind: &str) -> Vec<&'a Value> {
    seen.iter()
        .filter(|message| message["method"] == "session/update")
        .map(|message| &message["params"]["update"])
        .filter(|update| update["sessionUpdate"] == kind)
        .collect()
}

fn option<'a>(options: &'a Value, id: &str) -> &'a Value {
    options
        .as_array()
        .unwrap()
        .iter()
        .find(|option| option["id"] == id)
        .unwrap_or_else(|| panic!("missing option {id} in {options}"))
}

fn ids(options: &Value) -> Vec<String> {
    options
        .as_array()
        .unwrap()
        .iter()
        .map(|option| option["id"].as_str().unwrap().to_string())
        .collect()
}

#[tokio::test]
async fn models_command_prints_the_catalog_selector() {
    let dir = tempfile::tempdir().unwrap();
    let output = connector(&dir.path().join("log.jsonl"))
        .args(["models", "--format", "acp-config-options-v1", "--cwd"])
        .arg(dir.path())
        .output()
        .await
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let options: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(ids(&options), ["mode", "model", "access"]);
    let model = option(&options, "model");
    assert_eq!(model["category"], "model");
    assert_eq!(model["currentValue"], "composer-2.5");
    assert_eq!(model["options"].as_array().unwrap().len(), 4);
    let mode = option(&options, "mode");
    assert_eq!(mode["category"], "mode");
    assert_eq!(
        meta_values(mode, "permissionMode"),
        [("agent", "default"), ("plan", "plan"), ("ask", "ask")]
    );
    let access = option(&options, "access");
    assert_eq!(access["_meta"]["cadencr"]["role"], "access_mode");
    assert_eq!(
        meta_values(access, "accessMode"),
        [
            ("default", "default"),
            ("full_access", "fullAccess"),
            ("auto_review", "autoReview")
        ]
    );

    let version = connector(&dir.path().join("log.jsonl"))
        .arg("version")
        .output()
        .await
        .unwrap();
    assert_eq!(
        String::from_utf8_lossy(&version.stdout).trim(),
        env!("CARGO_PKG_VERSION")
    );
}

/// `(value, _meta.cadencr.<key>)` of each select value.
fn meta_values<'a>(option: &'a Value, key: &str) -> Vec<(&'a str, &'a str)> {
    option["options"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| {
            (
                entry["value"].as_str().unwrap(),
                entry["_meta"]["cadencr"][key].as_str().unwrap(),
            )
        })
        .collect()
}

#[tokio::test]
async fn host_integration_declares_worktree_config_only() {
    let dir = tempfile::tempdir().unwrap();
    let output = connector(&dir.path().join("log.jsonl"))
        .args([
            "host-integration",
            "--format",
            "cadencr-host-integration-v1",
        ])
        .output()
        .await
        .unwrap();
    assert!(output.status.success());
    let integration: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        integration,
        json!({
            "worktreeConfigPaths": [
                ".cursor/rules", ".cursor/commands", ".cursor/skills",
                ".cursor/mcp.json", ".cursor/cli.json"
            ]
        }),
        "no compactCommand / resumeCommand: Cursor ACP supports neither"
    );
    let wrong = connector(&dir.path().join("log.jsonl"))
        .args(["host-integration", "--format", "v0"])
        .output()
        .await
        .unwrap();
    assert!(!wrong.status.success());
}

#[tokio::test]
async fn slash_commands_match_the_live_list_without_a_session() {
    let dir = tempfile::tempdir().unwrap();
    let (repo, home) = (dir.path().join("repo"), dir.path().join("home"));
    for (path, content) in [
        (".cursor/commands/bar.md", "Command bar\n"),
        (".cursor/commands/Has Space.md", "Spaced\n"),
        (
            ".agents/skills/bar/SKILL.md",
            "---\ndescription: Skill bar\n---\n",
        ),
    ] {
        let path = repo.join(path);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, content).unwrap();
    }
    let loop_skill = home.join(".cursor/skills-cursor/loop/SKILL.md");
    std::fs::create_dir_all(loop_skill.parent().unwrap()).unwrap();
    std::fs::write(&loop_skill, "---\ndescription: Loop\n---\n").unwrap();
    std::fs::write(repo.join(".fake-live-commands"), "").unwrap();
    let log = dir.path().join("agent.jsonl");

    let output = connector(&log)
        .args([
            "slash-commands",
            "--format",
            "cadencr-slash-commands-v1",
            "--cwd",
        ])
        .arg(&repo)
        .current_dir(&repo)
        .env("HOME", &home)
        .output()
        .await
        .unwrap();
    assert!(output.status.success(), "{output:?}");
    let listed: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert!(
        agent_log(&log).is_empty(),
        "the listing never starts the Cursor CLI"
    );

    let mut host = Host::spawn(&log);
    host.request(
        "initialize",
        json!({ "protocolVersion": 1, "clientCapabilities": {} }),
    )
    .await;
    host.request(
        "session/new",
        json!({ "cwd": repo.to_string_lossy(), "mcpServers": [] }),
    )
    .await;
    // The update may overtake the proxy's own `session/new` answer.
    let is_commands = |message: &Value| {
        message["params"]["update"]["sessionUpdate"] == "available_commands_update"
    };
    let mut early = host.take_seen().into_iter().filter(|m| is_commands(m));
    let live = match early.next() {
        Some(message) => message,
        None => loop {
            let message = host.next_message().await;
            if is_commands(&message) {
                break message;
            }
        },
    }["params"]["update"]["availableCommands"]
        .clone();
    let as_listing: Vec<Value> = live
        .as_array()
        .unwrap()
        .iter()
        .map(|command| {
            let kind = command["_meta"]["cadencr"]["kind"]
                .as_str()
                .unwrap_or("command");
            json!({ "name": command["name"], "description": command["description"], "kind": kind })
        })
        .collect();
    assert_eq!(
        listed,
        json!([
            { "name": "copy-request-id", "description": "Copy the last request ID to clipboard", "kind": "command" },
            { "name": "bar", "description": "Command bar (project)", "kind": "command" },
            { "name": "loop", "description": "Loop (builtin skill)", "kind": "skill" }
        ])
    );
    assert_eq!(
        Value::Array(as_listing),
        listed,
        "live and pre-session lists agree"
    );
}

#[tokio::test]
async fn proxies_a_cursor_session_end_to_end() {
    let dir = tempfile::tempdir().unwrap();
    let log = dir.path().join("agent.jsonl");
    let mut host = Host::spawn(&log);

    let init = host
        .request(
            "initialize",
            json!({ "protocolVersion": 1, "clientCapabilities": { "fs": {} } }),
        )
        .await;
    assert_eq!(init["result"]["agentCapabilities"]["loadSession"], true);
    let agent = agent_log(&log);
    let child_init = &received(&agent, "initialize")[0];
    assert_eq!(
        child_init["clientCapabilities"]["_meta"]["parameterizedModelPicker"],
        true
    );
    assert_eq!(child_init["clientCapabilities"]["subagents"], true);
    assert_eq!(
        received(&agent, "authenticate")[0]["methodId"],
        "cursor_login"
    );
    assert_eq!(acp_spawns(&agent)[0], ["--sandbox", "enabled", "acp"]);

    let cwd = dir.path().to_string_lossy().to_string();
    let created = host
        .request("session/new", json!({ "cwd": cwd, "mcpServers": [] }))
        .await;
    let session_id = created["result"]["sessionId"].as_str().unwrap().to_string();
    let options = &created["result"]["configOptions"];
    assert_eq!(
        ids(options),
        ["mode", "model", "access"],
        "companions are hidden"
    );
    assert!(created["result"].get("models").is_none());
    assert_eq!(option(options, "model")["currentValue"], "composer-2.5");
    assert_eq!(option(options, "access")["currentValue"], "default");
    assert_eq!(
        meta_values(option(options, "mode"), "permissionMode"),
        [("agent", "default"), ("plan", "plan"), ("ask", "ask")],
        "live mode values carry the catalog mapping"
    );
    assert_eq!(
        option(options, "access")["_meta"]["cadencr"]["role"],
        "access_mode"
    );

    set_model_with_companions(&mut host, &log, &session_id).await;
    ask_question_round_trip(&mut host, &log, &session_id).await;
    plan_approval_runs_the_followup_in_the_same_turn(&mut host, &log, &session_id).await;
    full_access_restarts_and_reloads(&mut host, &log, &session_id, &cwd).await;
    auto_review_and_tool_normalization(&mut host, &log, &session_id).await;

    drop(host.stdin.take());
    let status = tokio::time::timeout(STEP_TIMEOUT, host.process.wait())
        .await
        .unwrap()
        .unwrap();
    assert!(status.success());
}

#[tokio::test]
async fn full_access_before_the_first_prompt_waits_for_cursor_to_save_it() {
    let dir = tempfile::tempdir().unwrap();
    let log = dir.path().join("agent.jsonl");
    let mut host = Host::spawn(&log);
    host.request("initialize", json!({ "protocolVersion": 1 }))
        .await;
    let cwd = dir.path().to_string_lossy().to_string();
    let created = host
        .request("session/new", json!({ "cwd": cwd, "mcpServers": [] }))
        .await;
    let session_id = created["result"]["sessionId"].as_str().unwrap().to_string();

    let reply = set_config(&mut host, &session_id, "access", "full_access").await;
    assert_eq!(
        option(&reply["result"]["configOptions"], "access")["currentValue"],
        "full_access"
    );
    assert_eq!(acp_spawns(&agent_log(&log)).len(), 1, "no restart yet");

    // The first turn runs in the sandboxed child; its permission requests are
    // approved like Run Everything, then the child restarts with Full Access.
    let reply = host
        .request(
            "session/prompt",
            json!({ "sessionId": session_id, "prompt": [{ "type": "text", "text": "tools" }] }),
        )
        .await;
    assert_eq!(reply["result"]["stopReason"], "end_turn");
    let agent = agent_log(&log);
    assert_eq!(
        acp_spawns(&agent)[1],
        ["--force", "--sandbox", "disabled", "acp"]
    );
    assert_eq!(received(&agent, "session/load")[0]["sessionId"], session_id);
    let reply = set_config(&mut host, &session_id, "access", "default").await;
    assert!(reply.get("error").is_none(), "{reply}");
    assert_eq!(
        acp_spawns(&agent_log(&log))[2],
        ["--sandbox", "enabled", "acp"]
    );
}

async fn set_config(host: &mut Host, session_id: &str, config_id: &str, value: &str) -> Value {
    host.request(
        "session/set_config_option",
        json!({ "sessionId": session_id, "configId": config_id, "value": value }),
    )
    .await
}

async fn set_model_with_companions(host: &mut Host, log: &Path, session_id: &str) {
    let reply = set_config(host, session_id, "model", "gpt-5.3-codex-high-fast").await;
    let options = &reply["result"]["configOptions"];
    assert_eq!(ids(options), ["mode", "model", "access"]);
    assert_eq!(
        option(options, "model")["currentValue"],
        "gpt-5.3-codex-high-fast"
    );
    let sets = received(&agent_log(log), "session/set_config_option");
    let sent: Vec<(String, Value)> = sets
        .iter()
        .map(|params| {
            (
                params["configId"].as_str().unwrap().to_string(),
                params["value"].clone(),
            )
        })
        .collect();
    assert_eq!(
        sent,
        [
            ("model".to_string(), json!("gpt-5.3-codex")),
            ("fast".to_string(), json!("true")),
            ("effort".to_string(), json!("high")),
        ]
    );

    // `auto` has no companions in the model-change response: none are sent.
    let reply = set_config(host, session_id, "model", "auto").await;
    assert_eq!(
        option(&reply["result"]["configOptions"], "model")["currentValue"],
        "auto"
    );
    let sets = received(&agent_log(log), "session/set_config_option");
    assert_eq!(sets.len(), 4);
    assert_eq!(sets[3]["value"], "default");

    let reply = set_config(host, session_id, "model", "composer-2.5-fast").await;
    assert_eq!(
        option(&reply["result"]["configOptions"], "model")["currentValue"],
        "composer-2.5-fast"
    );
}

async fn ask_question_round_trip(host: &mut Host, log: &Path, session_id: &str) {
    let mut asked = Vec::new();
    let reply = host
        .request_with(
            "session/prompt",
            json!({ "sessionId": session_id, "prompt": [{ "type": "text", "text": "ask" }] }),
            &mut |request| {
                asked.push(request.clone());
                json!({
                    "outcome": { "outcome": "selected", "optionId": "submit" },
                    "_meta": { "updatedInput": {
                        "answers": { "Which mode?": "Plan" },
                        "structured_answers": [{ "selectedOptionIds": ["plan"] }]
                    } }
                })
            },
        )
        .await;
    assert_eq!(reply["result"]["stopReason"], "end_turn");
    assert_eq!(asked.len(), 1);
    let permission = &asked[0]["params"];
    assert_eq!(asked[0]["method"], "session/request_permission");
    assert_eq!(permission["toolCall"]["name"], "AskUserQuestion");
    assert_eq!(
        permission["toolCall"]["rawInput"]["questions"][0]["question"],
        "Which mode?"
    );
    assert_eq!(permission["options"][0]["optionId"], "submit");
    let seen = host.take_seen();
    let announced = updates_of(&seen, "tool_call");
    assert_eq!(announced[0]["name"], "AskUserQuestion");
    assert_eq!(announced[0]["status"], "pending");
    // The fake agent's first request id is 101: Cursor's own answer schema.
    let responses: Vec<Value> = agent_log(log)
        .into_iter()
        .filter(|entry| entry["msg"]["id"] == 101 && entry["msg"].get("result").is_some())
        .map(|entry| entry["msg"]["result"].clone())
        .collect();
    assert_eq!(responses[0]["outcome"]["outcome"], "answered");
    assert_eq!(
        responses[0]["outcome"]["answers"][0],
        json!({ "questionId": "q1", "selectedOptionIds": ["plan"] })
    );
}

async fn plan_approval_runs_the_followup_in_the_same_turn(
    host: &mut Host,
    log: &Path,
    session_id: &str,
) {
    let mut gate_ids = Vec::new();
    let reply = host
        .request_with(
            "session/prompt",
            json!({ "sessionId": session_id, "prompt": [{ "type": "text", "text": "plan" }] }),
            &mut |request| {
                gate_ids.push(request["id"].clone());
                assert_eq!(request["params"]["toolCall"]["name"], "ExitPlanMode");
                assert_eq!(
                    request["params"]["toolCall"]["rawInput"]["plan"],
                    "1. Do it"
                );
                json!({ "outcome": { "outcome": "selected", "optionId": "approve" } })
            },
        )
        .await;
    assert_eq!(reply["result"]["stopReason"], "end_turn");
    assert_eq!(
        gate_ids,
        [json!("plan-1")],
        "the gate id is the plan toolCallId"
    );
    let seen = host.take_seen();
    let modes = updates_of(&seen, "current_mode_update");
    assert_eq!(modes[0]["currentModeId"], "agent");
    let config = updates_of(&seen, "config_option_update");
    assert_eq!(
        option(&config[0]["configOptions"], "mode")["currentValue"],
        "agent"
    );
    let texts: Vec<&str> = updates_of(&seen, "agent_message_chunk")
        .iter()
        .filter_map(|update| update["content"]["text"].as_str())
        .collect();
    assert_eq!(texts, ["plan accepted", "executing in agent"]);
    let agent = agent_log(log);
    assert_eq!(received(&agent, "session/set_mode")[0]["modeId"], "agent");
    let prompts = received(&agent, "session/prompt");
    assert_eq!(
        prompts.last().unwrap()["prompt"][0]["text"],
        "Plan approved. Proceed with execution."
    );
}

async fn full_access_restarts_and_reloads(
    host: &mut Host,
    log: &Path,
    session_id: &str,
    cwd: &str,
) {
    let reply = set_config(host, session_id, "access", "full_access").await;
    let options = &reply["result"]["configOptions"];
    assert_eq!(option(options, "access")["currentValue"], "full_access");
    assert_eq!(
        option(options, "model")["currentValue"],
        "composer-2.5-fast"
    );
    assert_eq!(option(options, "mode")["currentValue"], "agent");
    let seen = host.take_seen();
    assert!(
        updates_of(&seen, "agent_message_chunk").is_empty(),
        "session/load replay must not reach the host: {seen:?}"
    );
    let agent = agent_log(log);
    let spawns = acp_spawns(&agent);
    assert_eq!(spawns[1], ["--force", "--sandbox", "disabled", "acp"]);
    let loads = received(&agent, "session/load");
    assert_eq!(
        loads[0],
        json!({ "sessionId": session_id, "cwd": cwd, "mcpServers": [] })
    );
    assert_eq!(received(&agent, "authenticate").len(), 2);
    let sets = received(&agent, "session/set_config_option");
    let reapplied: Vec<&Value> = sets.iter().rev().take(2).collect();
    assert_eq!(reapplied[1]["value"], "composer-2.5");
    assert_eq!(
        reapplied[0],
        &json!({ "sessionId": session_id, "configId": "fast", "value": "true" })
    );
}

async fn auto_review_and_tool_normalization(host: &mut Host, log: &Path, session_id: &str) {
    let reply = set_config(host, session_id, "access", "auto_review").await;
    assert_eq!(
        option(&reply["result"]["configOptions"], "access")["currentValue"],
        "auto_review"
    );
    let spawns = acp_spawns(&agent_log(log));
    assert_eq!(spawns[2], ["--auto-review", "--sandbox", "enabled", "acp"]);
    host.take_seen();

    let reply = host
        .request(
            "session/prompt",
            json!({ "sessionId": session_id, "prompt": [{ "type": "text", "text": "tools" }] }),
        )
        .await;
    assert_eq!(reply["result"]["stopReason"], "end_turn");
    let seen = host.take_seen();
    let texts: Vec<&str> = updates_of(&seen, "agent_message_chunk")
        .iter()
        .filter_map(|update| update["content"]["text"].as_str())
        .collect();
    assert_eq!(
        texts,
        [r#"permission {"outcome": {"outcome": "selected", "optionId": "allow-once"}}"#]
    );
    let calls = updates_of(&seen, "tool_call");
    let names: Vec<&str> = calls
        .iter()
        .filter_map(|call| call["name"].as_str())
        .collect();
    assert_eq!(
        names,
        ["Bash", "Write", "Agent", "Agent", "Bash", "GenerateImage"]
    );
    assert_eq!(
        calls[1]["rawInput"],
        json!({ "file_path": "a.txt", "content": "hi" })
    );
    let call_updates = updates_of(&seen, "tool_call_update");
    assert_eq!(call_updates[0]["status"], "failed");
    assert_eq!(call_updates[0]["name"], "Agent");
    assert_eq!(call_updates[1]["rawInput"]["subagentType"], "qa");
    assert_eq!(call_updates[1]["rawInput"]["agentId"], "agent-7");
    assert!(call_updates[0].get("_meta").is_none());
    let background = call_updates[2];
    assert_eq!(background["toolCallId"], "task-bg");
    assert_eq!(background["name"], "Agent");
    assert_eq!(background["status"], "completed");
    assert_eq!(
        background["_meta"],
        json!({ "cursor": { "seen": true }, "cadencr": { "subagent": { "background": true } } })
    );
    background_subagent_reaches_the_parent_session(&seen, session_id);
    let plans = updates_of(&seen, "plan");
    assert_eq!(plans.len(), 1, "the child's plan stays out of the parent's");
    assert_eq!(plans[0]["entries"][0]["status"], "in_progress");
    assert_eq!(plans[0]["entries"][1]["status"], "pending");
}

/// Cursor's sub-agent session: its tool call nests under the launching call on
/// the parent session, its text becomes the summary that ends the run.
fn background_subagent_reaches_the_parent_session(seen: &[Value], session_id: &str) {
    let child_call = seen
        .iter()
        .find(|message| message["params"]["update"]["toolCallId"] == "child-sh")
        .expect("the child's tool call reaches the host");
    assert_eq!(child_call["params"]["sessionId"], session_id);
    assert_eq!(
        child_call["params"]["update"]["parentToolCallId"],
        "task-bg"
    );
    let child_image = updates_of(seen, "tool_call")
        .into_iter()
        .find(|update| update["toolCallId"] == "child-img")
        .expect("the child's extension call reaches the host");
    assert_eq!(child_image["parentToolCallId"], "task-bg");
    assert!(seen
        .iter()
        .all(|message| message["params"]["sessionId"] != "child-1"));
    assert!(
        seen.iter()
            .all(|message| message["params"]["update"]["toolCallId"] != "child-todo"),
        "the child's todo list stays out of the parent's"
    );
    assert!(updates_of(seen, "subagent_spawned").is_empty());
    assert!(updates_of(seen, "subagent_state_update").is_empty());
    let finished = updates_of(seen, "tool_call_update")
        .into_iter()
        .find(|update| update["_meta"]["cadencr"]["subagent"]["status"] == "completed")
        .expect("the run's end reaches the launching call");
    assert_eq!(finished["toolCallId"], "task-bg");
    assert_eq!(
        finished["_meta"]["cadencr"]["subagent"]["summary"],
        "child done"
    );
}
