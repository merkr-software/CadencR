use serde_json::Value;
use sha2::{Digest, Sha256};

use super::super::store::uuid_segment;
use super::background::addressed_message;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(super) struct ReportDigest([u8; 32]);

#[derive(Default)]
pub(super) struct ReportEvidence {
    pub(super) sent: Option<ReportDigest>,
    pub(super) reply: Option<ReportDigest>,
    pub(super) delivered: Option<DeliveredReport>,
}

pub(super) struct DeliveredReport {
    pub(super) sender: String,
    pub(super) digest: ReportDigest,
}

impl ReportEvidence {
    pub(super) fn from_value(row: &Value) -> Self {
        let content = row["content"].as_str().unwrap_or_default();
        match row["type"].as_str() {
            Some("PLANNER_RESPONSE") => Self {
                sent: row["tool_calls"][0]["args"]["Message"]
                    .as_str()
                    .and_then(report_digest),
                reply: report_digest(content),
                delivered: None,
            },
            Some("SYSTEM_MESSAGE") => Self {
                delivered: delivered_report(content),
                ..Self::default()
            },
            _ => Self::default(),
        }
    }
}

fn delivered_report(content: &str) -> Option<DeliveredReport> {
    let (sender, body) = addressed_message(content)?;
    let body = body.trim_end().strip_suffix("</SYSTEM_MESSAGE>")?;
    uuid_segment(sender).then_some(())?;
    Some(DeliveredReport {
        sender: sender.into(),
        digest: report_digest(body)?,
    })
}

fn report_digest(content: &str) -> Option<ReportDigest> {
    let text = content.trim();
    (!text.is_empty()).then(|| ReportDigest(Sha256::digest(text.as_bytes()).into()))
}

/// Hash a decoded string with the same trim semantics as `str::trim`.
#[derive(Clone, Default)]
pub(super) struct ReportHasher {
    digest: Sha256,
    before_whitespace: Option<Sha256>,
    started: bool,
}

impl ReportHasher {
    pub(super) fn push(&mut self, ch: char) {
        if ch.is_whitespace() {
            if !self.started {
                return;
            }
            self.before_whitespace
                .get_or_insert_with(|| self.digest.clone());
        } else {
            self.started = true;
            self.before_whitespace = None;
        }
        self.digest.update(ch.encode_utf8(&mut [0; 4]));
    }

    pub(super) fn finish(self) -> Option<ReportDigest> {
        self.started.then(|| {
            ReportDigest(
                self.before_whitespace
                    .unwrap_or(self.digest)
                    .finalize()
                    .into(),
            )
        })
    }
}
