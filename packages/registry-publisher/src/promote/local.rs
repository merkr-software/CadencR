use crate::github::Asset;
use crate::PublisherError;

pub(super) fn require_same_assets(before: &[Asset], after: &[Asset]) -> Result<(), PublisherError> {
    let mut before = before.to_vec();
    let mut after = after.to_vec();
    before.sort_by(|left, right| left.name.cmp(&right.name));
    after.sort_by(|left, right| left.name.cmp(&right.name));
    if before != after {
        return Err(PublisherError::new(
            "release assets changed during publication verification",
        ));
    }
    Ok(())
}
