//! The one revocation policy every marketplace kind applies — themes, custom
//! tabs, LSP servers and providers alike. Each kind keeps its own signed feed
//! and error codes; the decisions are these.
//!
//! A kind's policy is **available** when an authenticated policy is cached
//! and still valid, whether it was just fetched or the feed is unreachable.
//! It is **unavailable** when the build compiles no feed, nothing was fetched
//! yet, or the cached policy expired.
//!
//! | Policy      | Install, update | Start native code¹ | Inert use² | Remove |
//! |-------------|-----------------|--------------------|------------|--------|
//! | available   | unless listed   | unless listed      | unless listed | yes |
//! | unavailable | refused         | refused            | unless an authenticated cached policy lists it | yes |
//!
//! ¹ a tab's backend, an LSP server, a provider's agent. ² applying a theme,
//! serving a tab's page.
//!
//! Without a policy the host cannot learn of a revocation, and native code
//! runs unsandboxed with the user's rights: its trust rests on review,
//! signing, consent and this blocklist, so it fails closed.
use super::ExtensionKind;

/// Why a kind's policy is unavailable in a build that compiles no feed for it.
pub fn no_feed(kind: ExtensionKind) -> String {
    let noun = kind.noun();
    // Installed themes stay usable (inert); every other kind runs native code.
    let refused = if kind == ExtensionKind::Theme {
        "installed or updated"
    } else {
        "installed, updated or started"
    };
    format!("this build has no {noun} revocation feed, so no marketplace {noun} can be {refused}")
}
