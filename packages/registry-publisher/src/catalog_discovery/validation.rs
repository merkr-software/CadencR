use crate::github::discovery::{write, DiscoveryHead};
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
    write::require_candidate(head, snapshot.canonical_envelope(), "discovery")
}
pub(super) fn require_same_head(
    expected: Option<&DiscoveryHead>,
    actual: Option<&DiscoveryHead>,
) -> Result<(), PublisherError> {
    write::require_same_head(expected, actual, "discovery changed before advancement")
}
