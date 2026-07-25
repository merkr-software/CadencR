#![allow(
    clippy::cloned_ref_to_slice_refs,
    clippy::doc_lazy_continuation,
    clippy::derivable_impls,
    clippy::explicit_auto_deref,
    clippy::field_reassign_with_default,
    clippy::items_after_test_module,
    clippy::large_enum_variant,
    clippy::manual_async_fn,
    clippy::needless_return,
    clippy::new_without_default,
    clippy::nonminimal_bool,
    clippy::ptr_arg,
    clippy::question_mark,
    clippy::redundant_closure,
    clippy::result_large_err,
    clippy::should_implement_trait,
    clippy::too_many_arguments,
    clippy::type_complexity,
    clippy::unnecessary_get_then_check,
    clippy::unnecessary_lazy_evaluations,
    clippy::unnecessary_map_or,
    clippy::useless_format,
    clippy::useless_vec
)]

pub mod agents;
pub mod checkpoints;
pub mod custom_actions;
pub mod diff_comments;
pub mod editor;
pub mod feature_events;
pub mod feature_layouts;
pub mod features;
pub mod gate_registry;
pub mod git;
pub mod imports;
pub mod lsp;
pub mod mcp;
pub mod permission_bridge;
pub mod projects;
pub mod push;
pub mod remote;
pub mod runtime_stream;
pub mod schedules;
pub mod session_status;
pub mod sessions;
pub mod settings;
pub mod settings_allowlist;
pub mod settings_store;
pub mod terminal;
pub mod usage_stats;
pub mod workflow;
pub mod workspace;
pub mod ws_session;
