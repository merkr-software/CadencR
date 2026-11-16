//! Tests that write the process-global settings file.
//!
//! None of them call `settings_store::init`, so `global_write_content` replaces
//! the whole uninitialized fallback file shared by every test in the process.
//! They are kept out of `tests/integration` (whose spawn/permission tests read
//! those same keys) and serialize on one lock so a writer in one module can't
//! clobber another module's settings mid-test.

#[path = "../support/mod.rs"]
mod support;

mod mcp_control;
mod workspace_mcp_activity;
mod workspace_mcp_tools;

static SETTINGS_TEST_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
