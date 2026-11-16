const MAX_MESSAGES: usize = 256;
const MAX_BYTES: usize = 64 * 1024;
const OMITTED: &str = "additional validation errors omitted";

#[derive(Default)]
pub(crate) struct Diagnostics {
    messages: Vec<String>,
    bytes: usize,
    full: bool,
}

impl Diagnostics {
    pub(crate) fn push(&mut self, message: String) {
        if self.full {
            return;
        }
        let reserved_messages = MAX_MESSAGES - 1;
        let newline = usize::from(!self.messages.is_empty());
        let reserved_bytes = MAX_BYTES - OMITTED.len() - 1;
        if self.messages.len() >= reserved_messages
            || self.bytes + newline + message.len() > reserved_bytes
        {
            self.bytes += newline;
            self.messages.push(OMITTED.into());
            self.bytes += OMITTED.len();
            self.full = true;
            return;
        }
        self.bytes += newline + message.len();
        self.messages.push(message);
    }

    pub(crate) fn extend(&mut self, messages: impl IntoIterator<Item = String>) {
        for message in messages {
            self.push(message);
            if self.full {
                break;
            }
        }
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.messages.is_empty()
    }
    pub(crate) fn is_full(&self) -> bool {
        self.full
    }
    pub(crate) fn into_messages(self) -> Vec<String> {
        self.messages
    }
}

impl std::ops::Deref for Diagnostics {
    type Target = [String];

    fn deref(&self) -> &Self::Target {
        &self.messages
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn caps_adversarial_error_count_and_bytes_with_one_sentinel() {
        let mut diagnostics = Diagnostics::default();
        for _ in 0..10_000 {
            diagnostics.push("x".repeat(1024));
        }
        assert!(diagnostics.is_full());
        assert!(diagnostics.messages.len() <= MAX_MESSAGES);
        assert!(diagnostics.bytes <= MAX_BYTES);
        assert_eq!(diagnostics.messages.last().unwrap(), OMITTED);
        assert_eq!(
            diagnostics
                .messages
                .iter()
                .filter(|value| value.as_str() == OMITTED)
                .count(),
            1
        );
    }
}
