//! Remote-access domain logic: device-token persistence, pairing exchange, and
//! the HTTP routes. Runtime/transport state (the listener, pairing-code store,
//! live-session registry, pepper) lives in the `crate::remote` controller.

pub mod models;
pub mod repo;
pub mod revocation;
pub mod routes;
pub mod tokens;

pub use routes::{loopback_router, public_router};
