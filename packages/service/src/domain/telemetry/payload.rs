use serde_json::{json, Value};

use super::models::{DiagnosticReport, ProductEvent};

pub(super) fn product(
    event: ProductEvent,
    installation_id: &str,
    release: &str,
    key: &str,
) -> Value {
    let mut properties = json!({
        "$process_person_profile": false, "$geoip_disable": true, "$ip": "0.0.0.0",
        "release": release, "os": os(), "arch":std::env::consts::ARCH, "process": "service", "schema_version": 1,
    });
    if let ProductEvent::TurnCompleted(summary) = event {
        properties["outcome"] = json!(summary.outcome);
        properties["provider"] = json!(summary.provider);
        properties["duration_bucket"] = json!(summary.duration_bucket);
        properties["actor"] = json!(summary.actor);
    }
    json!({"api_key": key, "event": event.name(), "distinct_id": installation_id,
        "timestamp": chrono::Utc::now().to_rfc3339(), "properties": properties})
}

/// One fresh, unpersisted event identifier; never use the telemetry installation identity.
pub(super) fn audience(key: &str) -> Value {
    json!({
        "api_key": key,
        "event": "active_installation_monthly",
        "distinct_id": uuid::Uuid::new_v4().to_string(),
        "properties": {"$process_person_profile":false,"$geoip_disable":true,"$ip":"0.0.0.0"}
    })
}

pub(super) fn diagnostic(
    report: &DiagnosticReport,
    installation_id: &str,
    release: &str,
) -> String {
    let category = serde_json::to_value(report.category).expect("fixed enum serializes");
    let process = report.category.process();
    let frames: Vec<Value> = report
        .frames
        .iter()
        .map(|frame| {
            let filename = if process == "service" {
                frame.filename.clone()
            } else {
                format!("app:///{}", frame.filename)
            };
            json!({"filename": filename, "abs_path": filename, "lineno":frame.lineno,
            "colno":frame.colno, "in_app":true})
        })
        .collect();
    let mut exception = json!({"type":category,"value":"Cadencr diagnostic"});
    if !frames.is_empty() {
        exception["stacktrace"] = json!({"frames":frames});
    }
    let event_id = uuid::Uuid::new_v4().simple().to_string();
    let event = json!({
        "event_id":event_id, "timestamp": chrono::Utc::now().to_rfc3339(),
        "level":"error", "platform": if process == "service" {"native"} else {"javascript"},
        "release":release, "dist":report.build_id,
        "user":{"id":installation_id,"ip_address":"0.0.0.0"},
        "tags":{"process":process,"os":os(),"arch":std::env::consts::ARCH,"schema_version":"1"},
        "fingerprint":["{{ default }}",category],
        "exception":{"values":[exception]},
    });
    format!(
        "{}\n{}\n{}\n",
        json!({"event_id":event_id}),
        json!({"type":"event","length":event.to_string().len()}),
        event
    )
}

fn os() -> &'static str {
    if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        "other"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::telemetry::models::{
        DiagnosticCategory, DiagnosticFrame, TurnOutcome, TurnSummary,
    };

    #[test]
    fn minimal_protocols_include_no_ambient_metadata() {
        let value = product(
            ProductEvent::TurnCompleted(TurnSummary::new(
                TurnOutcome::Completed,
                "secret-custom-provider",
                12,
            )),
            "id",
            "cadencr@1",
            "key",
        );
        assert_eq!(value["properties"]["provider"], "custom");
        assert_eq!(value["properties"]["duration_bucket"], "under_one_minute");
        assert!(!value.to_string().contains("secret-custom-provider"));
        assert_eq!(value["distinct_id"], "id");
        assert_eq!(value["properties"]["$process_person_profile"], false);
        assert_eq!(value["properties"]["$geoip_disable"], true);
        let report = DiagnosticReport {
            category: DiagnosticCategory::ReactBoundary,
            build_id: Some("build".into()),
            frames: vec![
                DiagnosticFrame {
                    filename: "assets/index-abc.js".into(),
                    lineno: 2,
                    colno: 3,
                },
                DiagnosticFrame {
                    filename: "assets/index-def.js".into(),
                    lineno: 4,
                    colno: 5,
                },
            ],
        };
        let envelope = diagnostic(&report, "id", "cadencr@1");
        let lines: Vec<_> = envelope.lines().collect();
        let item: Value = serde_json::from_str(lines[1]).unwrap();
        assert_eq!(item["length"], lines[2].len());
        let event: Value = serde_json::from_str(lines[2]).unwrap();
        assert_eq!(event["dist"], "build");
        assert_eq!(
            event["exception"]["values"][0],
            json!({
                "type":"react_boundary", "value":"Cadencr diagnostic",
                "stacktrace":{"frames":[
                    {"filename":"app:///assets/index-abc.js", "abs_path":"app:///assets/index-abc.js",
                        "lineno":2, "colno":3, "in_app":true},
                    {"filename":"app:///assets/index-def.js", "abs_path":"app:///assets/index-def.js",
                        "lineno":4, "colno":5, "in_app":true}
                ]}
            })
        );
        assert_private_context_absent(&event);
    }

    #[test]
    fn diagnostic_without_trusted_frames_omits_stacktrace_and_sensitive_context() {
        let report = DiagnosticReport {
            category: DiagnosticCategory::RendererUnhandledError,
            build_id: None,
            frames: vec![],
        };
        let envelope = diagnostic(&report, "id", "cadencr@1");
        let lines: Vec<_> = envelope.lines().collect();
        let item: Value = serde_json::from_str(lines[1]).unwrap();
        assert_eq!(item["length"], lines[2].len());
        let event: Value = serde_json::from_str(lines[2]).unwrap();
        assert_eq!(
            event["exception"]["values"],
            json!([{"type":"renderer_unhandled_error", "value":"Cadencr diagnostic"}])
        );
        assert!(event["exception"]["values"][0].get("stacktrace").is_none());
        assert_private_context_absent(&event);
    }

    fn assert_private_context_absent(event: &Value) {
        for key in [
            "request",
            "breadcrumbs",
            "contexts",
            "server_name",
            "environment",
            "extra",
        ] {
            assert!(event.get(key).is_none());
        }
    }
}
