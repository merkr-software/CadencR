use std::fmt;

#[derive(Debug)]
pub struct RegistryError {
    messages: Vec<String>,
}

impl RegistryError {
    pub(crate) fn from_messages(messages: Vec<String>) -> Self {
        Self { messages }
    }

    pub(crate) fn single(message: impl Into<String>) -> Self {
        Self::from_messages(vec![message.into()])
    }

    pub fn messages(&self) -> &[String] {
        &self.messages
    }
}

impl fmt::Display for RegistryError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.messages.join("\n"))
    }
}

impl std::error::Error for RegistryError {}
