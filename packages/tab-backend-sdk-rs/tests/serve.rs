//! The protocol loop, driven in-process through `testing::TestHost`.

use cadencr_tab_backend::protocol::{RequestId, MAX_LINE_BYTES, PROTOCOL_VERSION};
use cadencr_tab_backend::testing::{sample_hello, TestHost};
use cadencr_tab_backend::{codes, Config, Context, Error, ServeError, SDK};
use serde_json::{json, Value};

// The example's `main` is not used here.
#[allow(dead_code)]
#[path = "../examples/echo.rs"]
mod echo;

fn host() -> TestHost {
    TestHost::new(echo::handle)
}

#[test]
fn answers_ready_then_requests() {
    let transcript = host().session([TestHost::request("1", "echo", json!({"a": [1, 2]}))]);
    transcript.outcome.as_ref().unwrap();
    let ready = transcript.ready().unwrap();
    assert_eq!(ready.protocol, PROTOCOL_VERSION);
    assert_eq!(ready.sdk.as_deref(), Some(SDK));
    assert_eq!(
        transcript.output[0],
        json!({"type": "ready", "protocol": 1, "sdk": SDK})
    );
    assert_eq!(
        transcript.output[1],
        json!({"type": "response", "id": "1", "result": {"a": [1, 2]}})
    );
}

#[test]
fn hands_the_hello_to_handlers() {
    let mut hello = sample_hello();
    hello.plugin.id = "acme.tab".into();
    hello.worktree = "/work/tree".into();
    hello.state_dir = "/state/acme".into();
    let result = host()
        .with_hello(hello)
        .call("whoami", Value::Null)
        .unwrap();
    assert_eq!(
        result,
        json!({"plugin": "acme.tab", "worktree": "/work/tree", "state_dir": "/state/acme"})
    );
}

#[test]
fn a_slow_request_does_not_hold_up_others() {
    let lines = [
        TestHost::request("slow", "sleep", json!({"ms": 300})),
        TestHost::request("fast", "echo", json!(1)),
    ];
    let order = |host: TestHost| -> Vec<RequestId> {
        let transcript = host.session(lines.clone());
        transcript.responses().into_iter().map(|r| r.id).collect()
    };
    assert_eq!(order(host()), ["fast".into(), "slow".into()]);
    let one_worker = host().with_config(Config::builder().workers(1).build());
    assert_eq!(order(one_worker), ["slow".into(), "fast".into()]);
}

#[test]
fn errors_and_panics_become_error_responses() {
    let transcript = host().session([
        TestHost::request("1", "nope", Value::Null),
        TestHost::request("2", "sleep", json!({"ms": "soon"})),
        TestHost::request("3", "panic", Value::Null),
        TestHost::request("4", "echo", json!("still alive")),
    ]);
    let code = |id: &str| transcript.response(id).unwrap().error.unwrap().code;
    assert_eq!(code("1"), codes::UNKNOWN_METHOD);
    assert_eq!(code("2"), codes::INVALID_PARAMS);
    let panicked = transcript.response("3").unwrap().error.unwrap();
    assert_eq!(panicked.code, codes::INTERNAL_ERROR);
    assert!(panicked.message.contains("asked to panic"));
    assert_eq!(
        transcript.response("4").unwrap().outcome(),
        Ok(&json!("still alive"))
    );
}

#[test]
fn skips_malformed_lines_and_answers_invalid_requests() {
    let transcript = host().session([
        "not json".to_string(),
        "[1, 2]".into(),
        json!({"type": "request", "method": "echo"}).to_string(),
        json!({"type": "request", "id": "bad"}).to_string(),
        json!({"type": "something-new", "id": "x"}).to_string(),
        json!({"type": "request", "id": 42, "method": "echo", "params": 1}).to_string(),
    ]);
    transcript.outcome.as_ref().unwrap();
    let responses = transcript.responses();
    assert_eq!(responses.len(), 2, "{:?}", transcript.output);
    assert_eq!(
        transcript.response("bad").unwrap().error.unwrap().code,
        codes::INVALID_REQUEST
    );
    // Numeric ids come back as numbers.
    let numeric = responses.iter().find(|r| r.id != "bad".into()).unwrap();
    assert_eq!(numeric.id, RequestId::Number(42.into()));
    assert!(transcript
        .output
        .contains(&json!({"type": "response", "id": 42, "result": 1})));
}

#[test]
fn refuses_a_missing_wrong_or_foreign_hello() {
    let refuse = |input: &str| {
        let transcript = host().raw_session(input);
        assert!(
            transcript.output.is_empty(),
            "wrote {:?}",
            transcript.output
        );
        transcript.outcome.unwrap_err()
    };
    assert!(matches!(refuse(""), ServeError::NoHello));
    let request = TestHost::request("1", "echo", Value::Null);
    assert!(matches!(
        refuse(&format!("{request}\n")),
        ServeError::NotHello(_)
    ));
    let mut hello = serde_json::to_value(cadencr_tab_backend::protocol::HostMessage::Hello(
        sample_hello(),
    ))
    .unwrap();
    hello["protocol"] = json!(2);
    let error = refuse(&format!("{hello}\n"));
    assert!(matches!(&error, ServeError::ProtocolMismatch { host } if *host == json!(2)));
    assert!(error.to_string().contains("protocol 2"));
}

fn huge(cx: &Context) -> Result<Value, Error> {
    match cx.method() {
        "huge" => Ok(json!("x".repeat(MAX_LINE_BYTES))),
        other => Err(Error::unknown_method(other)),
    }
}

#[test]
fn an_oversized_result_becomes_an_error() {
    let transcript = TestHost::new(huge).session([TestHost::request("1", "huge", Value::Null)]);
    let error = transcript.response("1").unwrap().error.unwrap();
    assert_eq!(error.code, codes::RESPONSE_TOO_LARGE);
}
