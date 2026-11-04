//! Fake editor: acknowledges navigation without reading or writing files.
use cadencr_tab_backend::{serve, Context, Error};
use serde_json::{json, Value};
use std::sync::Mutex;

fn main() -> std::process::ExitCode {
    let opened = Mutex::new(Value::Null);
    serve(move |cx: &Context| {
        let mut opened = opened
            .lock()
            .map_err(|_| Error::new("HOST_ERROR", "Editor state is unavailable"))?;
        match cx.method() {
            "editor.open" => {
                let params: Value = cx.params()?;
                if !params.get("path").is_some_and(Value::is_string)
                    || ["line", "column"].iter().any(|key| {
                        params.get(key).is_some_and(|value| {
                            value.as_u64().is_none_or(|position| position == 0)
                        })
                    })
                {
                    return Err(Error::new(
                        "BAD_REQUEST",
                        "Expected path and 1-based positions",
                    ));
                }
                *opened = params.clone();
                Ok(json!({"opened": params}))
            }
            "snapshot" => Ok(json!({"opened": *opened})),
            method => Err(Error::unknown_method(method)),
        }
    })
}
