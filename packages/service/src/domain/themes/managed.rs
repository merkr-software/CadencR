//! Managed themes are inert signed data, isolated from author projects and ACP.
//! The catalog, downloads and private storage they share with the other
//! managed kinds live in [`crate::domain::marketplace`].
pub mod archive;
pub mod catalog;
mod inventory;
pub mod models;
mod policy;
mod read;
pub mod routes;
pub mod service;
pub mod storage;
