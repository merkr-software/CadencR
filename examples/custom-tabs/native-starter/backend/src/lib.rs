//! The backend's methods. Replace them with what your tab needs a native
//! process for — anything a page cannot do: read files, run tools, keep state.
//!
//! | Method  | Params     | Result                         |
//! |---------|------------|--------------------------------|
//! | `about` | none       | `{folder, os, arch}`           |
//! | `greet` | `{name}`   | `{greeting}`                   |

use cadencr_tab_backend::{Context, Error};
use serde::Deserialize;
use serde_json::{json, Value};

/// Every request goes through here. A failure is answered to the page (which
/// shows it) and noted in the log, shown in the tab's Activity.
pub fn handle(cx: &Context) -> Result<Value, Error> {
    let result = match cx.method() {
        "about" => Ok(about(cx)),
        "greet" => greet(cx),
        other => Err(Error::unknown_method(other)),
    };
    if let Err(error) = &result {
        // stderr is the backend's log; stdout belongs to the protocol.
        eprintln!(
            "[{}] {} failed: {error}",
            env!("CARGO_PKG_NAME"),
            cx.method()
        );
    }
    result
}

/// What only a native process knows: this conversation's folder and the
/// system it runs on.
fn about(cx: &Context) -> Value {
    json!({
        "folder": cx.hello().worktree,
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
    })
}

#[derive(Deserialize)]
struct Greet {
    name: String,
}

/// A method with parameters: malformed ones are answered as an error.
fn greet(cx: &Context) -> Result<Value, Error> {
    let Greet { name } = cx.params()?;
    Ok(json!({ "greeting": format!("Hello, {name}, from a native backend") }))
}

#[cfg(test)]
mod tests {
    use cadencr_tab_backend::testing::TestHost;
    use serde_json::json;

    use super::handle;

    #[test]
    fn about_names_the_conversation_folder_and_the_system() {
        let host = TestHost::new(handle);
        let about = host.call("about", json!(null)).unwrap();
        assert_eq!(about["folder"], json!(host.hello().worktree));
        assert_eq!(about["os"], std::env::consts::OS);
    }

    #[test]
    fn greet_needs_a_name() {
        let host = TestHost::new(handle);
        assert_eq!(
            host.call("greet", json!({ "name": "Ada" })).unwrap(),
            json!({ "greeting": "Hello, Ada, from a native backend" })
        );
        assert!(host.call("greet", json!({})).is_err());
        assert!(host.call("missing", json!(null)).is_err());
    }
}
