//! Last-observed ACP `promptCapabilities` for one installation.
//!
//! Each spawned runtime reports what its `initialize` response advertised; the
//! adapter exposes the latest report in the catalog so the composer can gate
//! attachments before a prompt is ever sent. In memory only: a fresh process
//! reports nothing until a runtime has been spawned.

use std::sync::{Arc, RwLock};

use crate::domain::agents::runtime::ProviderPromptCapabilities;

#[derive(Clone, Default)]
pub struct SharedPromptCapabilities(Arc<RwLock<Option<ProviderPromptCapabilities>>>);

impl SharedPromptCapabilities {
    pub fn observe(&self, capabilities: ProviderPromptCapabilities) {
        *self
            .0
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(capabilities);
    }

    pub fn current(&self) -> Option<ProviderPromptCapabilities> {
        *self
            .0
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

#[cfg(test)]
mod tests {
    use super::SharedPromptCapabilities;
    use crate::domain::agents::runtime::ProviderPromptCapabilities;

    #[test]
    fn clones_share_the_latest_observation() {
        let shared = SharedPromptCapabilities::default();
        assert!(shared.current().is_none());
        let observed = ProviderPromptCapabilities {
            image: true,
            audio: false,
            embedded_context: true,
        };
        shared.clone().observe(observed);
        assert_eq!(shared.current(), Some(observed));
    }
}
