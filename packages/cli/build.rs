#[path = "release_version.rs"]
mod release_version;

fn main() {
    println!("cargo:rerun-if-env-changed=CADENCR_CLI_RELEASE_VERSION");
    let base = std::env::var("CARGO_PKG_VERSION").expect("package version");
    let override_version = match std::env::var("CADENCR_CLI_RELEASE_VERSION") {
        Ok(value) => Some(value),
        Err(std::env::VarError::NotPresent) => None,
        Err(error) => panic!("invalid CADENCR_CLI_RELEASE_VERSION: {error}"),
    };
    let version = release_version::resolve(&base, override_version.as_deref()).expect(
        "invalid CADENCR_CLI_RELEASE_VERSION: expected package-version-dev.RUN_ID.RUN_ATTEMPT",
    );
    println!("cargo:rustc-env=CADENCR_CLI_VERSION={version}");

    // Set by the desktop packaging step to the app version this CLI ships in;
    // `cadencr serve` passes it to the service. Empty in other builds.
    println!("cargo:rerun-if-env-changed=CADENCR_APP_VERSION");
    let app_version = match std::env::var("CADENCR_APP_VERSION") {
        Ok(value) => value,
        Err(std::env::VarError::NotPresent) => String::new(),
        Err(error) => panic!("invalid CADENCR_APP_VERSION: {error}"),
    };
    assert!(
        app_version
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b".-+".contains(&byte)),
        "invalid CADENCR_APP_VERSION: {app_version:?}"
    );
    println!("cargo:rustc-env=CADENCR_BUNDLED_APP_VERSION={app_version}");
}
