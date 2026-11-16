use std::collections::HashMap;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum ReasoningSection {
    Summary(u64),
    Content(u64),
}

#[derive(Default)]
struct ReasoningStream {
    marker_prefix: Option<String>,
    pending_section: Option<ReasoningSection>,
    visible_section: Option<ReasoningSection>,
    has_visible_content: bool,
    trailing_newlines: usize,
}

#[derive(Default)]
pub(super) struct ReasoningState {
    streams: HashMap<String, ReasoningStream>,
}

impl ReasoningState {
    pub(super) fn announce_section(&mut self, item_id: &str, section: ReasoningSection) {
        if let Some(stream) = self.streams.get_mut(item_id) {
            stream.pending_section = Some(section);
        } else {
            self.streams.insert(
                item_id.to_string(),
                ReasoningStream {
                    pending_section: Some(section),
                    ..ReasoningStream::default()
                },
            );
        }
    }

    pub(super) fn delta(
        &mut self,
        item_id: &str,
        section: Option<ReasoningSection>,
        delta: &str,
    ) -> String {
        if let Some(stream) = self.streams.get_mut(item_id) {
            return stream.delta(section, delta);
        }

        let mut stream = ReasoningStream::default();
        let output = stream.delta(section, delta);
        if stream.marker_prefix.is_some() || !output.is_empty() {
            self.streams.insert(item_id.to_string(), stream);
        }
        output
    }

    pub(super) fn finish(&mut self, item_id: &str) -> Option<String> {
        self.streams
            .remove(item_id)
            .and_then(|stream| stream.marker_prefix)
    }
}

impl ReasoningStream {
    fn delta(&mut self, section: Option<ReasoningSection>, delta: &str) -> String {
        let cleaned = self.delta_without_marker(delta);
        if cleaned.is_empty() {
            return cleaned;
        }

        let pending_section = self.pending_section.take();
        let section = section.or(pending_section).or(self.visible_section);
        let changed_section = self.has_visible_content && section != self.visible_section;
        let leading_newlines = cleaned
            .chars()
            .take_while(|character| *character == '\n')
            .count();
        let missing_newlines = if changed_section {
            2usize.saturating_sub(self.trailing_newlines + leading_newlines)
        } else {
            0
        };
        let output = if missing_newlines == 0 {
            cleaned
        } else {
            format!("{}{cleaned}", "\n".repeat(missing_newlines))
        };

        self.visible_section = section;
        self.has_visible_content = true;
        self.trailing_newlines = output
            .chars()
            .rev()
            .take_while(|character| *character == '\n')
            .count()
            .min(2);
        output
    }

    fn delta_without_marker(&mut self, delta: &str) -> String {
        const MARKER: &str = "<!-- -->";
        let combined = match self.marker_prefix.take() {
            Some(mut pending) => {
                pending.push_str(delta);
                pending
            }
            None if !delta.contains('<') => return delta.to_string(),
            None => delta.to_string(),
        };
        let mut cleaned = combined.replace(MARKER, "");
        let pending_len = (1..MARKER.len())
            .rev()
            .find(|length| cleaned.ends_with(&MARKER[..*length]))
            .unwrap_or_default();
        if pending_len > 0 {
            let pending = cleaned.split_off(cleaned.len() - pending_len);
            self.marker_prefix = Some(pending);
        }
        cleaned
    }
}
