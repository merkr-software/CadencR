use crate::github::discovery::DiscoveryHead;
use crate::PublisherError;

pub(super) fn assess(
    snapshot: &cadencr_registry_core::CatalogSnapshot,
    head: Option<&DiscoveryHead>,
) -> Result<bool, PublisherError> {
    cadencr_registry_core::assess_discovery_head(snapshot, head.map(|value| value.bytes.as_slice()))
        .map_err(Into::into)
}
pub(super) fn require_candidate(
    snapshot: &cadencr_registry_core::CatalogSnapshot,
    head: Option<&DiscoveryHead>,
) -> Result<(), PublisherError> {
    if head.is_some_and(|value| value.bytes == snapshot.canonical_envelope()) {
        Ok(())
    } else {
        Err(PublisherError::new(
            "discovery does not contain the candidate",
        ))
    }
}
pub(super) fn require_same_head(
    expected: Option<&DiscoveryHead>,
    actual: Option<&DiscoveryHead>,
) -> Result<(), PublisherError> {
    if expected == actual {
        Ok(())
    } else {
        Err(PublisherError::new("discovery changed before advancement"))
    }
}
