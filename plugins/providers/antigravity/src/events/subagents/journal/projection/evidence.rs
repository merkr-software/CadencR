use super::super::super::store::uuid_segment;
use super::super::background::addressed_message;
use super::super::report::{DeliveredReport, ReportEvidence, ReportHasher};

const MAX_HEADER_BYTES: usize = 16 * 1024;
const END_MESSAGE: &[u8] = b"</SYSTEM_MESSAGE>";

#[derive(Clone, Copy, PartialEq, Eq)]
enum Scope {
    Record,
    Calls,
    FirstCall,
    Arguments,
    Other,
}

#[derive(Default, Clone, Copy, PartialEq, Eq)]
enum Key {
    Content,
    ToolCalls,
    Args,
    Message,
    #[default]
    Other,
}

#[derive(Default)]
enum Field {
    Key(String),
    Content(Box<Content>),
    Message(Box<ReportHasher>),
    #[default]
    Other,
}

/// Collect digests from exactly `content` and `tool_calls[0].args.Message`
/// while the capped reader projects the rest of the JSON record for serde.
#[derive(Default)]
pub(super) struct StringEvidence {
    scopes: Vec<Scope>,
    last_token: u8,
    key: Key,
    field: Field,
    pub(super) report: ReportEvidence,
    pub(super) content_truncated: bool,
}

impl StringEvidence {
    pub(super) fn token(&mut self, token: u8) {
        if token.is_ascii_whitespace() {
            return;
        }
        match token {
            b'{' | b'[' => {
                let scope = match (self.scopes.last(), self.last_token, self.key, token) {
                    (None, _, _, b'{') => Scope::Record,
                    (Some(Scope::Record), b':', Key::ToolCalls, b'[') => Scope::Calls,
                    (Some(Scope::Calls), b'[', _, b'{') => Scope::FirstCall,
                    (Some(Scope::FirstCall), b':', Key::Args, b'{') => Scope::Arguments,
                    _ => Scope::Other,
                };
                self.scopes.push(scope);
                self.key = Key::Other;
            }
            b'}' | b']' => {
                self.scopes.pop();
                self.key = Key::Other;
            }
            _ => {}
        }
        self.last_token = token;
    }

    pub(super) fn start_string(&mut self) {
        self.field = match (self.scopes.last(), self.last_token, self.key) {
            (Some(Scope::Record | Scope::FirstCall | Scope::Arguments), b'{' | b',', _) => {
                Field::Key(String::new())
            }
            (Some(Scope::Record), b':', Key::Content) => Field::Content(Box::default()),
            (Some(Scope::Arguments), b':', Key::Message) => Field::Message(Box::default()),
            _ => Field::Other,
        };
    }

    pub(super) fn character(&mut self, ch: char) {
        match &mut self.field {
            Field::Key(key) if key.len() <= "tool_calls".len() => key.push(ch),
            Field::Content(content) => content.push(ch),
            Field::Message(message) => message.push(ch),
            _ => {}
        }
    }

    pub(super) fn finish_string(&mut self, truncated: bool) {
        match std::mem::take(&mut self.field) {
            Field::Key(key) => {
                self.key = match key.as_str() {
                    "content" => Key::Content,
                    "tool_calls" => Key::ToolCalls,
                    "args" => Key::Args,
                    "Message" => Key::Message,
                    _ => Key::Other,
                };
            }
            Field::Content(content) => {
                self.content_truncated = truncated;
                self.report.reply = content.plain.finish();
                self.report.delivered = content.envelope.finish();
            }
            Field::Message(message) => self.report.sent = message.finish(),
            Field::Other => {}
        }
        self.last_token = b'"';
    }
}

#[derive(Default)]
struct Content {
    plain: ReportHasher,
    envelope: Envelope,
}

impl Content {
    fn push(&mut self, ch: char) {
        self.plain.push(ch);
        self.envelope.push(ch);
    }
}

enum Envelope {
    Header(String),
    Body(Box<Body>),
    Unknown,
}

impl Default for Envelope {
    fn default() -> Self {
        Self::Header(String::new())
    }
}

impl Envelope {
    fn push(&mut self, ch: char) {
        match self {
            Self::Header(header) => {
                if header.len() + ch.len_utf8() > MAX_HEADER_BYTES {
                    *self = Self::Unknown;
                    return;
                }
                header.push(ch);
                if header.ends_with(" content=") {
                    if let Some((sender, _)) = addressed_message(header) {
                        *self = if uuid_segment(sender) {
                            Self::Body(Box::new(Body {
                                sender: sender.into(),
                                ..Body::default()
                            }))
                        } else {
                            Self::Unknown
                        };
                    }
                }
            }
            Self::Body(body) => body.push(ch),
            Self::Unknown => {}
        }
    }

    fn finish(self) -> Option<DeliveredReport> {
        let Self::Body(body) = self else { return None };
        body.finish()
    }
}

#[derive(Default)]
struct Body {
    sender: String,
    text: ReportHasher,
    before_close: Option<ReportHasher>,
    closing_bytes: usize,
}

impl Body {
    fn push(&mut self, ch: char) {
        // The exact closing tag counts as a terminator only at the trimmed end.
        // Keep hashing after a tentative tag in case the report has more text.
        if ch == '<' {
            self.before_close = Some(self.text.clone());
            self.closing_bytes = 1;
        } else if END_MESSAGE.get(self.closing_bytes).copied().map(char::from) == Some(ch) {
            self.closing_bytes += 1;
        } else if self.closing_bytes != END_MESSAGE.len() || !ch.is_whitespace() {
            self.before_close = None;
            self.closing_bytes = 0;
        }
        self.text.push(ch);
    }

    fn finish(self) -> Option<DeliveredReport> {
        (self.closing_bytes == END_MESSAGE.len()).then_some(())?;
        Some(DeliveredReport {
            sender: self.sender,
            digest: self.before_close?.finish()?,
        })
    }
}
