use crate::domain::sessions::user_messages::PersistedUserMessage;

#[derive(Debug)]
pub(crate) struct UserMessageDeliveryError {
    feature_id: i64,
}

impl UserMessageDeliveryError {
    pub fn new(feature_id: i64) -> Self {
        Self { feature_id }
    }
}

impl std::fmt::Display for UserMessageDeliveryError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "canonical user-message event could not reach its owner for feature {}",
            self.feature_id
        )
    }
}

pub(crate) struct CanonicalUserMessageOutcome {
    pub message: PersistedUserMessage,
    pub delivery: Result<(), UserMessageDeliveryError>,
}
