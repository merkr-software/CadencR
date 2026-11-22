#![cfg(unix)]

use std::path::PathBuf;
use std::process::{Output, Stdio};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};

const TIMEOUT: Duration = Duration::from_secs(10);

struct Fixture {
    directory: tempfile::TempDir,
    scenario: &'static str,
}

impl Fixture {
    fn new(scenario: &'static str) -> Self {
        Self {
            directory: tempfile::tempdir().unwrap(),
            scenario,
        }
    }

    fn command(&self) -> Command {
        let binary = match std::env::var_os("CADENCR_ANTIGRAVITY_TEST_BINARY") {
            Some(path) => {
                let path = PathBuf::from(path);
                assert!(path.is_absolute() && path.is_file());
                path
            }
            None => PathBuf::from(env!("CARGO_BIN_EXE_cadencr-antigravity-provider")),
        };
        let native = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/fake_agy.py");
        let mut command = Command::new(binary);
        command
            .current_dir(self.directory.path())
            .env("CADENCR_ANTIGRAVITY_COMMAND", native)
            .env("AGY_FIXTURE_SCENARIO", self.scenario)
            .kill_on_drop(true);
        command
    }

    async fn models(&self) -> Output {
        run_models(self.command(), self).await
    }

    fn cwd(&self) -> &str {
        self.directory.path().to_str().unwrap()
    }
}

async fn run_models(mut command: Command, fixture: &Fixture) -> Output {
    command.args([
        "models",
        "--format",
        "acp-config-options-v1",
        "--cwd",
        fixture.cwd(),
    ]);
    tokio::time::timeout(TIMEOUT, command.output())
        .await
        .unwrap()
        .unwrap()
}

struct Host {
    child: Child,
    input: ChildStdin,
    from_agent: Lines<BufReader<ChildStdout>>,
    next_id: u64,
}

impl Host {
    fn open(fixture: &Fixture) -> Self {
        let mut child = fixture
            .command()
            .args(["run", "--protocol", "acp-v1"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let input = child.stdin.take().unwrap();
        let from_agent = BufReader::new(child.stdout.take().unwrap()).lines();
        Self {
            child,
            input,
            from_agent,
            next_id: 0,
        }
    }

    async fn send(&mut self, frame: Value) {
        let mut line = serde_json::to_vec(&frame).unwrap();
        line.push(b'\n');
        self.input.write_all(&line).await.unwrap();
    }

    async fn start_request(&mut self, method: &str, params: Value) -> u64 {
        self.next_id += 1;
        let id = self.next_id;
        self.send(json!({"jsonrpc":"2.0", "id":id, "method":method, "params":params}))
            .await;
        id
    }

    async fn next(&mut self) -> Value {
        let line = tokio::time::timeout(TIMEOUT, self.from_agent.next_line())
            .await
            .expect("agent response timed out")
            .unwrap()
            .expect("agent closed stdout");
        serde_json::from_str(&line).unwrap()
    }

    async fn response(&mut self, id: u64) -> Value {
        loop {
            let frame = self.next().await;
            if frame["id"] == id {
                return frame;
            }
            assert_eq!(frame["method"], "session/update", "{frame}");
        }
    }

    async fn request(&mut self, method: &str, params: Value) -> Value {
        let id = self.start_request(method, params).await;
        self.response(id).await
    }

    async fn initialize(&mut self) -> Value {
        self.request(
            "initialize",
            json!({
                "protocolVersion": 1,
                "clientCapabilities": {},
                "clientInfo": {"name":"cadencr-conformance", "version":"0.16.3"}
            }),
        )
        .await
    }

    async fn close(self) {
        let Self {
            mut child, input, ..
        } = self;
        drop(input);
        let status = tokio::time::timeout(TIMEOUT, child.wait())
            .await
            .unwrap()
            .unwrap();
        assert!(status.success(), "{status}");
    }
}

fn option<'a>(options: &'a Value, id: &str) -> &'a Value {
    options
        .as_array()
        .unwrap()
        .iter()
        .find(|opt| opt["id"] == id)
        .unwrap()
}

fn values(option: &Value) -> Vec<&Value> {
    option["options"]
        .as_array()
        .unwrap()
        .iter()
        .map(|choice| &choice["value"])
        .collect()
}

#[tokio::test]
async fn cold_discovery_and_live_configuration_match_and_restore_across_processes() {
    let fixture = Fixture::new("normal");
    let output = fixture.models().await;
    assert!(output.status.success(), "{:?}", output.stderr);
    let catalog: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert!(!fixture
        .directory
        .path()
        .join("fixture-session.json")
        .exists());
    let cold_models = option(&catalog, "model");
    assert_eq!(cold_models["currentValue"], "mock-neon");
    let neon_effort = &cold_models["options"][0]["_meta"]["cadencr"];
    assert_eq!(neon_effort["supportsEffort"], true);
    assert_eq!(neon_effort["supportedEffortLevels"], json!(["low", "high"]));
    assert!(cold_models["options"][1].get("_meta").is_none());
    let cold_modes = option(&catalog, "mode");
    assert_eq!(cold_modes["currentValue"], "default");
    assert_eq!(
        cold_modes["options"][2]["_meta"]["cadencr"]["permissionMode"],
        "auto"
    );

    let mut original = Host::open(&fixture);
    let initialized = original.initialize().await;
    assert_eq!(initialized["result"]["protocolVersion"], 1);
    assert_eq!(
        initialized["result"]["agentInfo"]["version"],
        env!("CARGO_PKG_VERSION")
    );
    assert_eq!(
        initialized["result"]["agentInfo"]["_meta"]["antigravity"]["cliVersion"],
        "1.5.14"
    );

    let mcp_servers = json!([{"name":"fixture", "command":"fixture", "args":[], "env":[]}]);
    let created = original
        .request(
            "session/new",
            json!({
                "cwd":fixture.cwd(), "mcpServers":mcp_servers,
                "_meta":{"com.cadencr":{"purpose":"auto_name","systemPrompt":"Name the thread."}}
            }),
        )
        .await;
    let session = &created["result"]["sessionId"];
    let live = &created["result"]["configOptions"];
    assert_eq!(values(option(live, "model")), values(cold_models));
    for modes in [cold_modes, option(live, "mode")] {
        let accents: Vec<_> = modes["options"]
            .as_array()
            .unwrap()
            .iter()
            .map(|choice| {
                (
                    choice["value"].as_str().unwrap(),
                    choice["_meta"]["cadencr"]["modeAccent"].as_str().unwrap(),
                )
            })
            .collect();
        assert_eq!(
            accents,
            [
                ("default", "blue"),
                ("accept-edits", "green"),
                ("auto", "yellow"),
                ("plan", "violet")
            ]
        );
    }
    assert_eq!(option(live, "model")["currentValue"], "mock-alt-medium");
    assert!(live
        .as_array()
        .unwrap()
        .iter()
        .all(|option| option["id"] != "thought_level"));
    let auto_mode = &option(live, "mode")["options"][2]["_meta"];
    assert_eq!(auto_mode["antigravity"]["fixture"], true);
    assert_eq!(auto_mode["cadencr"]["permissionMode"], "auto");

    for (id, value) in [
        ("model", "mock-neon"),
        ("thought_level", "low"),
        ("mode", "auto"),
        ("mode", "plan"),
    ] {
        let request_id = original
            .start_request(
                "session/set_config_option",
                json!({
                    "sessionId":session, "configId":id, "value":value
                }),
            )
            .await;
        let update = loop {
            let frame = original.next().await;
            if frame["params"]["update"]["sessionUpdate"] == "config_option_update" {
                break frame;
            }
            assert_eq!(frame["method"], "session/update", "{frame}");
        };
        assert_eq!(
            option(&update["params"]["update"]["configOptions"], id)["currentValue"],
            value
        );
        assert_eq!(
            option(&update["params"]["update"]["configOptions"], "mode")["options"][1]["_meta"]
                ["cadencr"]["permissionMode"],
            "acceptEdits"
        );
        let changed = original.response(request_id).await;
        assert_eq!(
            option(&changed["result"]["configOptions"], id)["currentValue"],
            value
        );
        assert_eq!(
            values(option(&changed["result"]["configOptions"], "thought_level")),
            neon_effort["supportedEffortLevels"]
                .as_array()
                .unwrap()
                .iter()
                .collect::<Vec<_>>()
        );
    }
    original.close().await;

    for method in ["session/resume", "session/load"] {
        let mut fresh = Host::open(&fixture);
        fresh.initialize().await;
        let unknown = fresh
            .request(
                method,
                json!({
                    "sessionId":"nonexistent", "cwd":fixture.cwd(), "mcpServers":[]
                }),
            )
            .await;
        assert_eq!(unknown["error"]["message"], "Unknown session");
        let restored = fresh
            .request(
                method,
                json!({
                    "sessionId":session, "cwd":fixture.cwd(), "mcpServers":[]
                }),
            )
            .await;
        let config = &restored["result"]["configOptions"];
        assert_eq!(restored["result"]["sessionId"], *session);
        assert_eq!(option(config, "model")["currentValue"], "mock-neon");
        assert_eq!(option(config, "thought_level")["currentValue"], "low");
        assert_eq!(option(config, "mode")["currentValue"], "plan");
        fresh.close().await;
    }

    let trace =
        std::fs::read_to_string(fixture.directory.path().join("fixture-requests.jsonl")).unwrap();
    let requests: Vec<Value> = trace
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    let creates: Vec<_> = requests
        .iter()
        .filter(|frame| frame["method"] == "session/new")
        .collect();
    assert_eq!(creates.len(), 1);
    assert_eq!(creates[0]["params"]["mcpServers"], mcp_servers);
    assert_eq!(
        creates[0]["params"]["_meta"]["antigravity"]["systemPrompt"]["append"],
        "Name the thread."
    );
}

#[tokio::test]
async fn a_native_session_can_decline_auto_mode() {
    let fixture = Fixture::new("no-auto-mode");
    let mut host = Host::open(&fixture);
    host.initialize().await;
    let created = host
        .request(
            "session/new",
            json!({"cwd": fixture.cwd(), "mcpServers": []}),
        )
        .await;
    let session_id = &created["result"]["sessionId"];
    let mode = option(&created["result"]["configOptions"], "mode");
    assert_eq!(mode["currentValue"], "default");
    assert_eq!(values(mode), ["default", "accept-edits", "plan"]);

    let response = host
        .request(
            "session/set_config_option",
            json!({"sessionId": session_id, "configId": "mode", "value": "auto"}),
        )
        .await;
    assert_eq!(response["error"]["message"], "Value unavailable");
    assert!(response.get("result").is_none());
    host.close().await;
}

#[tokio::test]
async fn permissions_and_cancellation_work_while_a_prompt_is_in_flight() {
    let fixture = Fixture::new("normal");
    let mut host = Host::open(&fixture);
    host.initialize().await;
    let session = host
        .request("session/new", json!({"cwd":fixture.cwd(), "mcpServers":[]}))
        .await;
    let params = json!({
        "sessionId": session["result"]["sessionId"],
        "prompt": [{"type":"text", "text":"Fixture prompt"}]
    });
    for cancelled in [false, true] {
        let id = host.start_request("session/prompt", params.clone()).await;
        loop {
            let frame = host.next().await;
            if frame["method"] == "session/request_permission" {
                assert_eq!(frame["id"], "approval-1");
                assert_eq!(frame["params"]["options"][1]["optionId"], "deny");
                let tool = &frame["params"]["toolCall"];
                assert_eq!(tool["name"], "Bash");
                assert_eq!(tool["rawInput"]["command"], "printf fixture");
                break;
            }
            assert_eq!(frame["method"], "session/update", "{frame}");
        }
        if cancelled {
            host.send(
                json!({"jsonrpc":"2.0", "method":"session/cancel", "params":{
                    "sessionId":params["sessionId"]
                }}),
            )
            .await;
        } else {
            host.send(json!({"jsonrpc":"2.0", "id":"approval-1", "result":{
                "outcome":{"outcome":"selected", "optionId":"deny"}
            }}))
            .await;
        }
        let result = host.response(id).await;
        assert_eq!(
            result["result"]["stopReason"],
            if cancelled { "cancelled" } else { "end_turn" }
        );
    }
    let closed = host
        .request("session/close", json!({"sessionId":params["sessionId"]}))
        .await;
    assert_eq!(closed["result"], json!({}));
    host.close().await;
}

#[tokio::test]
async fn multi_step_detached_reply_emits_one_completion_after_tools_and_final_text() {
    let fixture = Fixture::new("detached-reply");
    let mut host = Host::open(&fixture);
    host.initialize().await;
    let session = host
        .request("session/new", json!({"cwd":fixture.cwd(), "mcpServers":[]}))
        .await;
    let result = host
        .request(
            "session/prompt",
            json!({"sessionId":session["result"]["sessionId"],"prompt":[{"type":"text","text":"Start a subagent"}]}),
        )
        .await;
    assert_eq!(
        result["result"],
        json!({"stopReason":"end_turn","usage":{"inputTokens":90,"outputTokens":11,"totalTokens":101}})
    );

    let thought = host.next().await;
    assert_eq!(
        thought["params"]["update"]["sessionUpdate"],
        "agent_thought_chunk"
    );
    assert_eq!(
        thought["params"]["update"]["content"]["text"],
        "Verify the sources"
    );
    assert_eq!(
        host.next().await["params"]["update"],
        json!({"sessionUpdate":"usage_update","used":114,"size":1048576})
    );
    for n in 0..5 {
        let call = host.next().await;
        let update = &call["params"]["update"];
        assert_eq!(update["sessionUpdate"], "tool_call");
        assert_eq!(update["toolCallId"], format!("read-{n}"));
        assert_eq!(update["name"], "Read");
        assert_eq!(host.next().await["params"]["update"]["status"], "completed");
    }
    let thought = host.next().await;
    assert_eq!(
        thought["params"]["update"]["sessionUpdate"],
        "agent_thought_chunk"
    );
    assert_eq!(
        thought["params"]["update"]["content"]["text"],
        "The sources agree"
    );
    let chunk = host.next().await;
    assert_eq!(
        chunk["params"]["update"]["sessionUpdate"],
        "agent_message_chunk"
    );
    assert_eq!(
        chunk["params"]["update"]["content"]["text"],
        "Subagent result"
    );

    let usage = json!({"sessionUpdate":"usage_update","used":137,"size":1048576});
    for _ in 0..2 {
        assert_eq!(host.next().await["params"]["update"], usage);
    }
    assert_eq!(
        host.next().await["params"]["update"],
        json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":""}})
    );
    let closing = host.next().await;
    assert_eq!(closing["method"], "session/update");
    assert_eq!(
        closing["params"]["sessionId"],
        session["result"]["sessionId"]
    );
    assert_eq!(
        closing["params"]["update"],
        json!({"sessionUpdate":"usage_update","used":137,"size":1048576,"_meta":{"cadencr":{"detachedReplyEnded":true}}})
    );
    assert!(
        tokio::time::timeout(Duration::from_millis(100), host.from_agent.next_line())
            .await
            .is_err()
    );
    host.close().await;
}

#[tokio::test]
async fn discovery_and_session_errors_explain_how_to_sign_in() {
    let fixture = Fixture::new("signed-out");
    let output = fixture.models().await;
    assert!(!output.status.success());
    let failure: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(failure["code"], "AUTHENTICATION_REQUIRED");
    assert!(String::from_utf8_lossy(&output.stderr).contains("agy acp --login"));

    let mut host = Host::open(&fixture);
    host.initialize().await;
    let response = host
        .request("session/new", json!({"cwd":fixture.cwd(), "mcpServers":[]}))
        .await;
    assert_eq!(response["error"]["code"], -32000);
    assert_eq!(response["error"]["data"]["fixture"], true);
    assert!(response["error"]["message"]
        .as_str()
        .unwrap()
        .contains("agy acp --login"));
    host.close().await;
}

#[tokio::test]
async fn absent_cli_and_invalid_override_fail_without_spawning_an_agent() {
    let fixture = Fixture::new("normal");
    let mut missing = fixture.command();
    missing
        .env_remove("CADENCR_ANTIGRAVITY_COMMAND")
        .env("PATH", fixture.cwd())
        .env("HOME", fixture.cwd());
    let output = run_models(missing, &fixture).await;
    assert!(!output.status.success());
    let failure: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(failure["code"], "CLI_NOT_FOUND");

    let mut invalid = fixture.command();
    invalid.env("CADENCR_ANTIGRAVITY_COMMAND", "./agy");
    let output = run_models(invalid, &fixture).await;
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("absolute path"));
}

#[tokio::test]
async fn native_exit_and_malformed_output_tear_down_a_live_connection() {
    for scenario in ["native-exit", "malformed"] {
        let fixture = Fixture::new(scenario);
        let mut host = Host::open(&fixture);
        host.start_request("initialize", json!({"protocolVersion":1}))
            .await;
        let status = tokio::time::timeout(TIMEOUT, host.child.wait())
            .await
            .unwrap()
            .unwrap();
        assert!(!status.success());
    }
}
