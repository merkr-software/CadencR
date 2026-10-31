//! Service-owned session runtime state and application operations.

pub(crate) mod application;
pub(crate) mod output;
pub(crate) mod prompt;
pub(crate) mod registry;
pub(crate) mod state;
pub(crate) mod turns;

pub(crate) use registry::SessionRuntimeRegistry;

pub(crate) mod access;
pub(crate) mod control_policy;
pub(crate) mod helpers;
pub(crate) mod post_plan_mode;
pub(crate) mod session_init_resume;
pub(crate) mod session_profile;
pub(crate) mod session_runtime_config;

use helpers::{default_permission_mode, send_error, send_runtime_session_id};
use state::{QueryState, SdkHandle, SdkSessions, SessionConfig, WsSender};
use turns::ActiveTurnRegistry;
