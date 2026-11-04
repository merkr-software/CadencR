//! Protocol-v2 publishing through the real loop and worker pool.

use std::sync::{Arc, Barrier, Mutex};
use std::thread;

use cadencr_tab_backend::protocol::{parse_event, MAX_EVENT_BYTES, MAX_TOPIC_BYTES};
use cadencr_tab_backend::testing::{sample_hello, TestHost};
use cadencr_tab_backend::{codes, Context, Error, EventEmitter};
use serde_json::{json, Value};

fn v2_host<H: cadencr_tab_backend::Handler>(handler: H) -> TestHost {
    let mut hello = sample_hello();
    hello.protocol = 2;
    TestHost::new(handler).with_hello(hello)
}

#[test]
fn emits_events_and_responses_without_interleaving_concurrent_lines() {
    const REQUESTS: usize = 8;
    const EVENTS: usize = 16;
    let barrier = Arc::new(Barrier::new(REQUESTS));
    let host = v2_host(move |cx: &Context| {
        let emitter = cx.emitter();
        let id = cx.id().to_string();
        barrier.wait();
        let publisher = thread::spawn(move || {
            for index in 0..EVENTS {
                emitter.emit("updates.état", json!({"request": id, "index": index}))?;
            }
            Ok::<_, Error>(())
        });
        publisher.join().unwrap()?;
        Ok(json!(cx.id()))
    });
    let transcript = host.session(
        (0..REQUESTS).map(|id| TestHost::request(&id.to_string(), "publish", Value::Null)),
    );
    transcript.outcome.as_ref().unwrap();
    assert_eq!(transcript.ready().unwrap().protocol, 2);
    assert_eq!(transcript.responses().len(), REQUESTS);
    let events = transcript.events();
    assert_eq!(events.len(), REQUESTS * EVENTS);
    for id in 0..REQUESTS {
        let id_text = id.to_string();
        let mut indices: Vec<_> = events
            .iter()
            .filter(|event| event.payload["request"] == id_text)
            .map(|event| event.payload["index"].as_u64().unwrap())
            .collect();
        indices.sort_unstable();
        assert_eq!(indices, (0..EVENTS as u64).collect::<Vec<_>>());
        assert!(transcript
            .response(&id.to_string())
            .unwrap()
            .error
            .is_none());
    }
    assert!(events.iter().all(|event| event.topic == "updates.état"));
}

#[test]
fn refuses_events_in_v1_without_changing_the_v1_wire_messages() {
    let host = TestHost::new(|cx: &Context| {
        let error = cx.emitter().emit("topic", Value::Null).unwrap_err();
        assert_eq!(error.code(), codes::EVENTS_UNSUPPORTED);
        Ok(json!("v1"))
    });
    let transcript = host.session([TestHost::request("legacy", "publish", Value::Null)]);
    assert_eq!(transcript.output.len(), 2);
    assert_eq!(transcript.ready().unwrap().protocol, 1);
    assert_eq!(
        transcript.output[1],
        json!({"type":"response","id":"legacy","result":"v1"})
    );
}

#[test]
fn enforces_topic_and_serialized_event_limits_without_writing_bad_events() {
    let host = v2_host(|cx: &Context| {
        for topic in [
            "".to_owned(),
            "bad\nname".into(),
            "bad\0name".into(),
            "x".repeat(MAX_TOPIC_BYTES + 1),
        ] {
            assert_eq!(
                cx.emitter().emit(topic, Value::Null).unwrap_err().code(),
                codes::INVALID_EVENT
            );
        }
        // JSON string escaping counts towards the actual wire limit.
        let prefix = br#"{"type":"event","topic":"t","payload":""}"#.len();
        let fits = json!("x".repeat(MAX_EVENT_BYTES - prefix));
        cx.emitter().emit("t", fits)?;
        let too_large = json!("x".repeat(MAX_EVENT_BYTES - prefix + 1));
        assert_eq!(
            cx.emitter().emit("t", too_large).unwrap_err().code(),
            codes::EVENT_TOO_LARGE
        );
        assert_eq!(
            cx.emitter()
                .emit("t", json!("\n".repeat(MAX_EVENT_BYTES / 2)))
                .unwrap_err()
                .code(),
            codes::EVENT_TOO_LARGE
        );
        Ok(Value::Null)
    });
    let transcript = host.session([TestHost::request("limits", "publish", Value::Null)]);
    assert!(transcript.response("limits").unwrap().error.is_none());
    assert_eq!(transcript.events().len(), 1);
    let line = serde_json::to_vec(&transcript.output[1]).unwrap();
    assert_eq!(line.len(), MAX_EVENT_BYTES);
    assert!(parse_event(&line).is_ok());
}

#[test]
fn a_retained_publisher_reports_closed_output_after_the_run() {
    let retained: Arc<Mutex<Option<EventEmitter>>> = Arc::default();
    let saved = retained.clone();
    let transcript = v2_host(move |cx: &Context| {
        *saved.lock().unwrap() = Some(cx.emitter());
        Ok(Value::Null)
    })
    .session([TestHost::request("save", "save", Value::Null)]);
    assert!(transcript.response("save").unwrap().error.is_none());
    let emitter = retained.lock().unwrap().take().unwrap();
    assert_eq!(
        emitter.emit("after", Value::Null).unwrap_err().code(),
        codes::OUTPUT_ERROR
    );
}
