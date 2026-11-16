use agent_client_protocol::schema::v1::SessionConfigOption;

use super::command_probe::model_contract;
use super::{error, ManagedConformanceError, ManagedConformanceErrorCode, ModelContract};

/// A new session may start with another valid model. Its selector and complete
/// ordered catalog must still match discovery before we apply the host choice.
pub(super) fn reconcile_model_catalog(
    options: Option<&[SessionConfigOption]>,
    expected: &ModelContract,
    code: ManagedConformanceErrorCode,
    message: &str,
) -> Result<ModelContract, ManagedConformanceError> {
    let actual = model_contract(options.unwrap_or_default(), code)?;
    if actual.config_id != expected.config_id || actual.model_ids != expected.model_ids {
        return Err(error(code, message));
    }
    Ok(actual)
}

/// Once the host selected a model, both confirmation and durable restore must
/// preserve that exact selection as well as the catalog.
pub(super) fn reconcile_models(
    options: Option<&[SessionConfigOption]>,
    expected: &ModelContract,
    code: ManagedConformanceErrorCode,
    message: &str,
) -> Result<(), ManagedConformanceError> {
    let actual = reconcile_model_catalog(options, expected, code, message)?;
    if actual.current_model != expected.current_model {
        return Err(error(code, message));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn options(current: &str) -> Vec<SessionConfigOption> {
        serde_json::from_value(json!([{
            "id": "model", "name": "Model", "category": "model", "type": "select",
            "currentValue": current,
            "options": [
                {"value": "small", "name": "Small"},
                {"value": "large", "name": "Large"}
            ]
        }]))
        .unwrap()
    }

    #[test]
    fn a_valid_initial_choice_can_differ_but_confirmation_and_restore_cannot() {
        let expected = model_contract(
            &options("small"),
            ManagedConformanceErrorCode::ModelDiscoveryFailed,
        )
        .unwrap();
        let live = options("large");
        assert!(reconcile_model_catalog(
            Some(&live),
            &expected,
            ManagedConformanceErrorCode::ModelContractMismatch,
            "initial"
        )
        .is_ok());
        for code in [
            ManagedConformanceErrorCode::ConfigurationFailed,
            ManagedConformanceErrorCode::RestoreFailed,
        ] {
            assert_eq!(
                reconcile_models(Some(&live), &expected, code, "selected")
                    .unwrap_err()
                    .code,
                code
            );
            assert!(reconcile_models(Some(&options("small")), &expected, code, "selected").is_ok());
        }
    }

    #[test]
    fn initial_reconciliation_still_rejects_invalid_defaults_and_catalog_changes() {
        let code = ManagedConformanceErrorCode::ModelContractMismatch;
        let expected = model_contract(&options("small"), code).unwrap();
        assert!(reconcile_model_catalog(None, &expected, code, "initial").is_err());
        assert!(
            reconcile_model_catalog(Some(&options("unknown")), &expected, code, "initial").is_err()
        );
        let mut changed = serde_json::to_value(options("large")).unwrap();
        changed[0]["id"] = json!("another-model");
        let changed: Vec<SessionConfigOption> = serde_json::from_value(changed).unwrap();
        assert!(reconcile_model_catalog(Some(&changed), &expected, code, "initial").is_err());
        let mut changed = serde_json::to_value(options("large")).unwrap();
        changed[0]["options"].as_array_mut().unwrap().reverse();
        let changed: Vec<SessionConfigOption> = serde_json::from_value(changed).unwrap();
        assert!(reconcile_model_catalog(Some(&changed), &expected, code, "initial").is_err());
    }
}
