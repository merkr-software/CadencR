use codex_app_server_sdk_rs::SdkError;

#[derive(Debug, PartialEq, Eq)]
pub(super) enum SteerFailureRecovery {
    StartNewTurn,
    RetryWithTurn(String),
}

pub(super) fn steer_failure_recovery(error: &SdkError) -> Option<SteerFailureRecovery> {
    if error.is_no_active_turn_to_steer() {
        return Some(SteerFailureRecovery::StartNewTurn);
    }
    if let Some(found_turn_id) = error.active_turn_mismatch_found_id() {
        return Some(SteerFailureRecovery::RetryWithTurn(
            found_turn_id.to_string(),
        ));
    }
    None
}

#[cfg(test)]
mod tests {
    use codex_app_server_sdk_rs::SdkError;

    use super::{steer_failure_recovery, SteerFailureRecovery};

    #[test]
    fn mismatch_retries_with_server_reported_active_turn() {
        let error = SdkError::Rpc {
            code: -32600,
            message: "expected active turn id `019ef34f-f998-7753-b1b0-608715221a03` but found `019ef348-6e61-7813-9228-fd9045112a07`".to_string(),
        };

        assert_eq!(
            steer_failure_recovery(&error),
            Some(SteerFailureRecovery::RetryWithTurn(
                "019ef348-6e61-7813-9228-fd9045112a07".to_string()
            ))
        );
    }

    #[test]
    fn mismatch_parser_ignores_unrelated_rpc_error_that_mentions_found() {
        let error = SdkError::Rpc {
            code: -32600,
            message: "some other validation failed but found `turn_like_text`".to_string(),
        };

        assert_eq!(steer_failure_recovery(&error), None);
    }
}
