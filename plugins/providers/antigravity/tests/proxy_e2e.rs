#![cfg(unix)]

use std::path::{Path, PathBuf};
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
        let fixture = Self {
            directory: tempfile::tempdir().unwrap(),
            scenario,
        };
        std::fs::create_dir(fixture.home()).unwrap();
        fixture
    }

    fn home(&self) -> PathBuf {
        self.directory.path().join("home")
    }

    fn native() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/fake_agy.py")
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
        let mut command = Command::new(binary);
        command
            .current_dir(self.directory.path())
            .env("HOME", self.home())
            .env_remove("ANTIGRAVITY_CLI_PATH")
            .env("CADENCR_ANTIGRAVITY_COMMAND", Self::native())
            .env("AGY_FIXTURE_SCENARIO", self.scenario)
            .kill_on_drop(true);
        command
    }

    async fn advance_child_journal(&self, stage: &str) {
        let status = tokio::time::timeout(
            TIMEOUT,
            Command::new(Self::native())
                .env("HOME", self.home())
                .args(["fixture-child-journal", stage])
                .kill_on_drop(true)
                .status(),
        )
        .await
        .unwrap()
        .unwrap();
        assert!(status.success(), "child journal stage {stage}: {status}");
    }

    async fn models(&self) -> Output {
        run_models(self.command(), self).await
    }

    fn cwd(&self) -> &str {
        self.directory.path().to_str().unwrap()
    }
}

#[tokio::test]
async fn first_command_listing_includes_project_skills_without_starting_the_cli() {
    let fixture = Fixture::new("normal");
    let skill = fixture.directory.path().join(".agents/skills/deploy");
    std::fs::create_dir_all(&skill).unwrap();
    std::fs::write(
        skill.join("SKILL.md"),
        "---\nname: ship\ndescription: Deploy changes\n---\n",
    )
    .unwrap();
    let output = fixture
        .command()
        .args([
            "slash-commands",
            "--format",
            "cadencr-slash-commands-v1",
            "--cwd",
            fixture.cwd(),
        ])
        .output()
        .await
        .unwrap();
    assert!(output.status.success(), "{:?}", output.stderr);
    let catalog: Vec<Value> = serde_json::from_slice(&output.stdout).unwrap();
    assert!(catalog.iter().any(|c| c["name"] == "goal"));
    assert!(catalog
        .iter()
        .any(|c| c["name"] == "ship" && c["description"] == "Deploy changes"));
    assert!(!fixture
        .directory
        .path()
        .join("fixture-requests.jsonl")
        .exists());
    assert!(!fixture
        .directory
        .path()
        .join("fixture-session.json")
        .exists());
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

    async fn next_update(&mut self, session: &str) -> Value {
        let frame = self.next().await;
        assert_eq!(frame["method"], "session/update", "{frame}");
        assert_eq!(frame["params"]["sessionId"], session, "{frame}");
        frame["params"]["update"].clone()
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

async fn session_with_mcp(fixture: &Fixture) -> (Host, String) {
    let mut host = Host::open(fixture);
    assert_eq!(host.initialize().await["result"]["protocolVersion"], 1);
    let created = host
        .request(
            "session/new",
            json!({
                "cwd": fixture.cwd(),
                "mcpServers": [{"name":"fixture_tools","command":"fixture","args":[],"env":[]}]
            }),
        )
        .await;
    let session = created["result"]["sessionId"].as_str().unwrap().to_owned();
    assert_eq!(
        host.next_update(&session).await["sessionUpdate"],
        "available_commands_update"
    );
    (host, session)
}

fn prompt(session: &str, text: &str) -> Value {
    json!({"sessionId":session,"prompt":[{"type":"text","text":text}]})
}

fn assert_mcp_call(call: &Value, tool: &str) {
    assert_eq!(
        call["name"],
        format!("mcp__fixture_tools__{tool}"),
        "{call}"
    );
    assert_eq!(
        call["rawInput"],
        json!({"server":"fixture_tools","tool":tool,"arguments":{"query":"ACP"}})
    );
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
    assert_eq!(cold_models["_meta"]["cadencr"]["promptSteering"], true);
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
        initialized["result"]["agentCapabilities"]["_meta"]["cadencr"]["promptSteering"],
        true
    );
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
        let choices = modes["options"].as_array().unwrap();
        let auto = choices
            .iter()
            .find(|choice| choice["value"] == "auto")
            .unwrap();
        assert!(auto["description"]
            .as_str()
            .unwrap()
            .contains("approve MCP tools"));
        let accents: Vec<_> = choices
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
async fn mcp_tools_and_fixed_choice_permissions_round_trip_with_native_ids() {
    let fixture = Fixture::new("permissions-and-mcp");
    let (mut host, session) = session_with_mcp(&fixture).await;
    for (text, choice) in [
        ("Choose a deployment target", "preview-id"),
        ("Reject a custom choice", "custom"),
    ] {
        let id = host
            .start_request("session/prompt", prompt(&session, text))
            .await;
        let tool = host.next_update(&session).await;
        assert_eq!(tool["sessionUpdate"], "tool_call");
        assert_eq!(tool["toolCallId"], "mcp-call");
        assert_mcp_call(&tool, "search_records");
        assert_eq!(tool["toolName"], tool["name"]);

        let permission = host.next().await;
        assert_eq!(permission["id"], "mcp-permission");
        assert_eq!(permission["method"], "session/request_permission");
        assert_eq!(permission["params"]["sessionId"], session);
        assert_mcp_call(&permission["params"]["toolCall"], "search_records");
        assert_eq!(
            permission["params"]["options"],
            json!([
                {"optionId":"grant-once","name":"Allow once","kind":"allow_once"},
                {"optionId":"grant-always","name":"Allow always (Applies to future searches.)","kind":"allow_always",
                 "_meta":{"agy.security.warning":{"title":"Persistent grant","message":"Applies to future searches."}}}
            ])
        );
        host.send(json!({"jsonrpc":"2.0","id":permission["id"],"result":{
            "outcome":{"outcome":"selected","optionId":"grant-always"}
        }}))
        .await;

        let result = host.next_update(&session).await;
        assert_eq!(result["sessionUpdate"], "tool_call_update");
        assert_eq!(result["toolCallId"], "mcp-call");
        assert_eq!(result["status"], "completed");
        assert_eq!(result["rawOutput"], "2 records");

        let question = host.next().await;
        assert_eq!(question["id"], "choose-target");
        assert_eq!(question["method"], "session/request_permission");
        assert_eq!(question["params"]["sessionId"], session);
        let tool = &question["params"]["toolCall"];
        assert_eq!(tool["name"], "AskUserQuestion");
        assert_eq!(tool["toolName"], "AskUserQuestion");
        assert_eq!(
            tool["rawInput"],
            json!({"questions":[{
                "id":"interaction_target","question":"Choose a target","multiSelect":false,"allowCustomAnswer":false,
                "options":[{"id":"staging-id","label":"Staging"},{"id":"preview-id","label":"Preview"}]
            }]})
        );
        // The generic ACP selection and structured answer intentionally differ.
        host.send(json!({"jsonrpc":"2.0","id":question["id"],"result":{
            "outcome":{"outcome":"selected","optionId":"staging-id"},
            "_meta":{"updatedInput":{"structured_answers":[{
                "questionId":"interaction_target","selectedOptionIds":[choice]
            }]}}
        }}))
        .await;
        assert_eq!(host.response(id).await["result"]["stopReason"], "end_turn");
    }
    host.close().await;
}

#[tokio::test]
async fn child_journal_projects_actions_metadata_and_background_work_to_its_parent() {
    let fixture = Fixture::new("child-journal");
    let (mut host, session) = session_with_mcp(&fixture).await;
    let id = host
        .start_request("session/prompt", prompt(&session, "Start a researcher"))
        .await;
    let launch = host.next_update(&session).await;
    let carrier = &launch["toolCallId"];
    assert_eq!(launch["sessionUpdate"], "tool_call");
    assert_eq!(launch["name"], "Agent");
    assert_eq!(launch["rawInput"]["name"], "Researcher");
    let dispatched = host.next_update(&session).await;
    assert_eq!(dispatched["toolCallId"], *carrier);
    assert_eq!(dispatched["status"], "completed");
    assert_eq!(
        dispatched["_meta"]["cadencr"]["subagent"]["background"],
        true
    );
    let boundary = host.response(id).await;
    assert_eq!(boundary["result"]["stopReason"], "end_turn");
    assert_eq!(
        boundary["result"]["_meta"]["cadencr"]["backgroundWorkPending"],
        true
    );

    // The native registry and journal can appear after the parent already replied.
    fixture.advance_child_journal("actions").await;
    let read = host.next_update(&session).await;
    assert_eq!(read["sessionUpdate"], "tool_call");
    assert_eq!(read["parentToolCallId"], *carrier);
    assert_eq!(read["name"], "Read");
    assert_eq!(read["rawInput"]["file_path"], "source.txt");
    let read_result = host.next_update(&session).await;
    assert_eq!(read_result["sessionUpdate"], "tool_call_update");
    assert_eq!(read_result["toolCallId"], read["toolCallId"]);
    assert_eq!(read_result["parentToolCallId"], *carrier);
    assert_eq!(read_result["status"], "completed");
    assert_eq!(read_result["rawOutput"], "Source notes");
    let mcp = host.next_update(&session).await;
    assert_eq!(mcp["sessionUpdate"], "tool_call");
    assert_eq!(mcp["parentToolCallId"], *carrier);
    assert_mcp_call(&mcp, "count_hits");
    let running = host.next_update(&session).await;
    assert_eq!(running["sessionUpdate"], "tool_call_update");
    assert_eq!(running["toolCallId"], *carrier);
    assert_eq!(
        running["_meta"]["cadencr"]["subagent"],
        json!({"resolvedModel":"mock-child","totalTokens":126})
    );

    fixture.advance_child_journal("finish").await;
    let mcp_result = host.next_update(&session).await;
    assert_eq!(mcp_result["sessionUpdate"], "tool_call_update");
    assert_eq!(mcp_result["toolCallId"], mcp["toolCallId"]);
    assert_eq!(mcp_result["parentToolCallId"], *carrier);
    assert_eq!(mcp_result["status"], "completed");
    assert_eq!(mcp_result["rawOutput"], "2 records");
    let finished = host.next_update(&session).await;
    assert_eq!(finished["sessionUpdate"], "tool_call_update");
    assert_eq!(finished["toolCallId"], *carrier);
    assert_eq!(
        finished["_meta"]["cadencr"]["subagent"],
        json!({
            "status":"completed","summary":"Two records match ACP.",
            "resolvedModel":"mock-child-v2","totalTokens":201
        })
    );
    host.send(json!({"jsonrpc":"2.0","method":"fixture/wake","params":{}}))
        .await;
    assert_eq!(
        host.next_update(&session).await["sessionUpdate"],
        "agent_message_chunk"
    );
    assert_eq!(
        host.next_update(&session).await["sessionUpdate"],
        "usage_update"
    );
    assert_eq!(
        host.next_update(&session).await["_meta"]["cadencr"],
        json!({"detachedReplyEnded":true,"backgroundWorkPending":false})
    );
    host.close().await;
}

#[tokio::test]
async fn steering_acknowledges_both_prompts_while_the_original_command_finishes() {
    let fixture = Fixture::new("steer-during-command");
    let (mut host, session) = session_with_mcp(&fixture).await;
    let first = host
        .start_request("session/prompt", prompt(&session, "Start Bash"))
        .await;
    assert_eq!(host.next_update(&session).await["name"], "Bash");
    let steer = host
        .start_request("session/prompt", prompt(&session, "Change course"))
        .await;
    assert_eq!(
        host.response(first).await["result"]["stopReason"],
        "end_turn"
    );
    assert_eq!(
        host.next_update(&session).await["content"]["text"],
        "New instruction received."
    );
    let boundary = host.response(steer).await;
    assert_eq!(
        boundary["result"]["_meta"]["cadencr"]["backgroundWorkPending"],
        true
    );
    host.send(json!({"jsonrpc":"2.0","method":"fixture/finish-task","params":{}}))
        .await;
    assert_eq!(host.next_update(&session).await["toolCallId"], "task");
    host.send(json!({"jsonrpc":"2.0","method":"fixture/wake","params":{}}))
        .await;
    assert_eq!(
        host.next_update(&session).await["content"]["text"],
        "The task returned."
    );
    assert_eq!(
        host.next_update(&session).await["sessionUpdate"],
        "usage_update"
    );
    assert_eq!(
        host.next_update(&session).await["_meta"]["cadencr"],
        json!({"detachedReplyEnded":true,"backgroundWorkPending":false})
    );
    host.close().await;
}

#[tokio::test]
async fn steering_emits_user_message_chunk_when_native_transcript_ingests_the_steer() {
    let fixture = Fixture::new("steer-receipt");
    let (mut host, session) = session_with_mcp(&fixture).await;
    let first = host
        .start_request("session/prompt", prompt(&session, "Start command"))
        .await;
    assert_eq!(host.next_update(&session).await["name"], "Bash");
    let steer = host
        .start_request(
            "session/prompt",
            json!({
                "sessionId": session,
                "messageId": "steer-receipt-uuid",
                "prompt": [{"type": "text", "text": "Also run step two"}],
            }),
        )
        .await;
    assert_eq!(
        host.response(first).await["result"]["stopReason"],
        "end_turn"
    );
    // While the command is still running and the steer is not in transcript_full.jsonl yet,
    // no user_message_chunk receipt is emitted.
    assert!(
        tokio::time::timeout(Duration::from_millis(400), host.next())
            .await
            .is_err(),
        "steer must not be acknowledged before agy ingests it"
    );
    host.send(json!({
        "jsonrpc": "2.0",
        "method": "fixture/ingest-steer",
        "params": { "text": "Also run step two" },
    }))
    .await;
    let receipt = host.next_update(&session).await;
    assert_eq!(receipt["sessionUpdate"], "user_message_chunk");
    assert_eq!(receipt["messageId"], "steer-receipt-uuid");
    assert_eq!(receipt["content"]["text"], "Also run step two");

    host.send(json!({"jsonrpc":"2.0","method":"fixture/finish-steer","params":{}}))
        .await;
    assert_eq!(
        host.response(steer).await["result"]["stopReason"],
        "end_turn"
    );
    host.close().await;
}

#[tokio::test]
async fn command_and_timer_completion_keep_working_until_the_native_wake_finishes() {
    for name in ["run_command", "schedule"] {
        let fixture = Fixture::new("background-wake");
        let (mut host, session) = session_with_mcp(&fixture).await;
        let id = host
            .start_request("session/prompt", prompt(&session, name))
            .await;
        let boundary = host.response(id).await;
        assert_eq!(
            boundary["result"]["_meta"]["cadencr"]["backgroundWorkPending"], true,
            "{name}"
        );
        host.send(json!({"jsonrpc":"2.0","method":"fixture/finish-task","params":{}}))
            .await;
        assert_eq!(host.next_update(&session).await["status"], "completed");
        // Native agy can be completely silent between the task's completion and its wake.
        assert!(
            tokio::time::timeout(Duration::from_millis(150), host.next())
                .await
                .is_err(),
            "{name} released the conversation before its wake"
        );
        host.send(json!({"jsonrpc":"2.0","method":"fixture/wake","params":{}}))
            .await;
        assert_eq!(
            host.next_update(&session).await["sessionUpdate"],
            "agent_message_chunk"
        );
        assert_eq!(
            host.next_update(&session).await["sessionUpdate"],
            "usage_update"
        );
        assert_eq!(
            host.next_update(&session).await["_meta"]["cadencr"],
            json!({"detachedReplyEnded":true,"backgroundWorkPending":false})
        );
        host.close().await;
    }
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
        .env("PATH", fixture.cwd());
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
async fn connector_accepts_managed_override_without_the_legacy_host_variable() {
    let fixture = Fixture::new("normal");
    let mut managed = fixture.command();
    managed
        .env_remove("CADENCR_ANTIGRAVITY_COMMAND")
        .env("ANTIGRAVITY_CLI_PATH", Fixture::native());
    assert!(run_models(managed, &fixture).await.status.success());

    let mut conflicting = fixture.command();
    conflicting.env("ANTIGRAVITY_CLI_PATH", "./agy");
    let output = run_models(conflicting, &fixture).await;
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("ANTIGRAVITY_CLI_PATH"));
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
