use std::path::Path;

use serde_json::Value;

use crate::fs::{read_bounded, write_private_synced};
use crate::stage::{partial_path, StageReceipt, RECEIPT};
use crate::PublisherError;

const MAX_RECEIPT_BYTES: u64 = 4 * 1024 * 1024;

pub(crate) fn validate_existing_receipt(
    directory: &Path,
    plan: &Value,
) -> Result<(), PublisherError> {
    let path = directory.join(RECEIPT);
    match std::fs::symlink_metadata(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(PublisherError::io("inspect staging receipt", error)),
        Ok(_) => {}
    };
    let bytes = read_bounded(&path, MAX_RECEIPT_BYTES, "staging receipt")?;
    let value = cadencr_registry_core::parse_json_bytes(&bytes)
        .map_err(|_| PublisherError::new("existing staging receipt is invalid"))?;
    let receipt: StageReceipt = serde_json::from_value(value)
        .map_err(|_| PublisherError::new("existing staging receipt is invalid"))?;
    if cadencr_registry_core::canonical_json_bytes(&receipt.plan)
        != cadencr_registry_core::canonical_json_bytes(plan)
    {
        return Err(PublisherError::new(
            "staging directory belongs to a different publication plan",
        ));
    }
    Ok(())
}

pub(crate) fn publish_receipt(
    directory: &Path,
    receipt: &StageReceipt,
) -> Result<(), PublisherError> {
    let value = serde_json::to_value(receipt)
        .map_err(|_| PublisherError::new("cannot serialize staging receipt"))?;
    publish_document(directory, RECEIPT, &value, Comparison::ExactBytes)
}

pub(crate) fn publish_canonical_receipt(
    directory: &Path,
    name: &str,
    value: &Value,
) -> Result<(), PublisherError> {
    publish_document(directory, name, value, Comparison::CanonicalJson)
}

#[derive(Clone, Copy)]
enum Comparison {
    ExactBytes,
    CanonicalJson,
}

fn publish_document(
    directory: &Path,
    name: &str,
    value: &Value,
    comparison: Comparison,
) -> Result<(), PublisherError> {
    let mut bytes = cadencr_registry_core::canonical_json_bytes(value);
    bytes.push(b'\n');
    if bytes.len() as u64 > MAX_RECEIPT_BYTES {
        return Err(PublisherError::new("staging receipt exceeds 4 MiB"));
    }
    let partial = partial_path(directory, name);
    let identity = write_private_synced(&partial, &bytes)?;
    reconcile_receipt(
        &partial,
        identity,
        &directory.join(name),
        &bytes,
        comparison,
    )
}

fn reconcile_receipt(
    partial: &Path,
    identity: crate::fs::Identity,
    destination: &Path,
    bytes: &[u8],
    comparison: Comparison,
) -> Result<(), PublisherError> {
    let publish = match std::fs::hard_link(partial, destination) {
        Ok(()) => verify_linked_receipt(destination, identity, bytes),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => match comparison {
            Comparison::ExactBytes => compare_existing(destination, bytes),
            Comparison::CanonicalJson => compare_canonical(destination, bytes),
        },
        Err(error) => Err(PublisherError::io("publish staging receipt", error)),
    };
    let cleanup = crate::fs::remove_owned(partial, identity);
    match (publish, cleanup) {
        (Ok(()), Ok(())) => Ok(()),
        (Ok(()), Err(error)) => Err(PublisherError::io("remove receipt partial", error)),
        (Err(primary), Ok(())) => Err(primary),
        (Err(primary), Err(_)) => Err(PublisherError::cleanup(primary, 1)),
    }
}

fn verify_linked_receipt(
    destination: &Path,
    identity: crate::fs::Identity,
    bytes: &[u8],
) -> Result<(), PublisherError> {
    let metadata = std::fs::symlink_metadata(destination)
        .map_err(|error| PublisherError::io("inspect published receipt", error))?;
    if !identity.matches(&metadata) {
        return Err(PublisherError::new(
            "published staging receipt changed while being verified",
        ));
    }
    compare_existing(destination, bytes)
}

fn compare_existing(destination: &Path, bytes: &[u8]) -> Result<(), PublisherError> {
    let existing = read_bounded(destination, MAX_RECEIPT_BYTES, "staging receipt")?;
    if existing == bytes {
        Ok(())
    } else {
        Err(PublisherError::new("existing staging receipt conflicts"))
    }
}

fn compare_canonical(destination: &Path, bytes: &[u8]) -> Result<(), PublisherError> {
    let existing = read_bounded(destination, MAX_RECEIPT_BYTES, "publication receipt")?;
    let value = cadencr_registry_core::parse_json_bytes(&existing)
        .map_err(|_| PublisherError::new("existing publication receipt is invalid"))?;
    if cadencr_registry_core::canonical_json_bytes(&value)
        == bytes.strip_suffix(b"\n").unwrap_or(bytes)
    {
        Ok(())
    } else {
        Err(PublisherError::new(
            "existing publication receipt conflicts",
        ))
    }
}

#[cfg(all(test, unix))]
mod tests {
    use std::os::unix::fs::symlink;

    use serde_json::json;

    use super::*;

    #[test]
    fn canonical_receipt_replay_preserves_equivalent_original_bytes() {
        let root = tempfile::tempdir().unwrap();
        let destination = root.path().join("mirror-receipt.json");
        let bytes = b"{ \"b\": 2, \"a\": 1.0 }";
        std::fs::write(&destination, bytes).unwrap();
        publish_canonical_receipt(root.path(), "mirror-receipt.json", &json!({"a":1,"b":2}))
            .unwrap();
        assert_eq!(std::fs::read(&destination).unwrap(), bytes);
        assert!(
            publish_canonical_receipt(root.path(), "mirror-receipt.json", &json!({"a":9})).is_err()
        );
        assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 1);
    }

    #[test]
    fn malformed_oversize_and_symlink_receipts_fail_closed() {
        let root = tempfile::tempdir().unwrap();
        let receipt = root.path().join(RECEIPT);
        for bytes in [b"{".to_vec(), vec![b'x'; MAX_RECEIPT_BYTES as usize + 1]] {
            std::fs::write(&receipt, bytes).unwrap();
            assert!(validate_existing_receipt(root.path(), &json!({})).is_err());
            std::fs::remove_file(&receipt).unwrap();
        }
        let target = root.path().join("target");
        std::fs::write(&target, b"{}").unwrap();
        symlink(&target, &receipt).unwrap();
        assert!(validate_existing_receipt(root.path(), &json!({})).is_err());
    }
}
