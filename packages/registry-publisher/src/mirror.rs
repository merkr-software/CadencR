use crate::binding::{
    build_publication_binding, compact_artifacts, read_mirror_receipt, MirrorReceipt,
};
use crate::github::ReleaseClient;
use crate::publication_local::{self, RefusingDownloader};
use crate::stage;
use crate::{PublisherError, StageRequest};

pub(crate) fn mirror(
    request: StageRequest<'_>,
    registry_commit: &str,
    client: &impl ReleaseClient,
) -> Result<MirrorReceipt, PublisherError> {
    crate::validate_registry_commit(registry_commit)?;
    let lock = publication_local::acquire(request.directory, "mirror")?;
    let result = mirror_locked(request, registry_commit, client);
    match result {
        Ok(receipt) => {
            lock.release(None)?;
            Ok(receipt)
        }
        Err(error) => {
            lock.release(Some(error))?;
            unreachable!("release returns the primary error")
        }
    }
}

pub(crate) mod release;
use release::{resolve_release, revalidate_release, verify_tag};

pub(crate) mod artifacts;
use artifacts::{
    publish_receipt, upload_one, validate_local_artifact, validated_assets, verify_present,
};

mod lifecycle;
use lifecycle::mirror_locked;
#[cfg(test)]
pub(crate) mod fixture;
