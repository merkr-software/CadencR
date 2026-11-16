//! Compatibility imports for the transport handlers. Runtime state is service-owned.

pub use super::super::runtime::state::SdkHandle;
pub(crate) use super::super::runtime::state::{new_sdk_sessions, SdkSessions};
pub(super) use super::super::runtime::state::{QueryState, SessionConfig, WsSender};
