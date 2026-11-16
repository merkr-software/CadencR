//! The built backend binary against the protocol, checked the way the
//! Cadencr host drives it (`cadencr-tab-backend`'s `conformance` feature).

use std::path::Path;

use cadencr_tab_backend::conformance::{self, Options};

#[test]
fn the_backend_binary_conforms_to_the_protocol() {
    let binary = Path::new(env!(concat!("CARGO_BIN_EXE_", env!("CARGO_PKG_NAME"))));
    let report = conformance::run(binary, &Options::default());
    print!("{report}");
    assert!(
        report.passed(),
        "{report}\nstderr: {:?}",
        report.stderr_tail
    );
}
