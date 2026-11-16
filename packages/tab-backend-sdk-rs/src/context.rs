//! What a handler sees of one request, and the handler trait itself.

use std::path::Path;
use std::sync::Arc;

use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::error::Error;
use crate::protocol::{Hello, RequestId};

/// Handles every request of one backend. Called concurrently from several
/// worker threads, hence `Send + Sync`.
///
/// Any `fn(&Context) -> Result<Value, Error>` is a handler:
///
/// ```
/// use cadencr_tab_backend::{Context, Error};
/// use serde_json::{json, Value};
///
/// fn handle(cx: &Context) -> Result<Value, Error> {
///     match cx.method() {
///         "ping" => Ok(json!("pong")),
///         other => Err(Error::unknown_method(other)),
///     }
/// }
/// # let _: &dyn cadencr_tab_backend::Handler = &handle;
/// ```
pub trait Handler: Send + Sync + 'static {
    fn handle(&self, cx: &Context) -> Result<Value, Error>;
}

impl<F> Handler for F
where
    F: Fn(&Context) -> Result<Value, Error> + Send + Sync + 'static,
{
    fn handle(&self, cx: &Context) -> Result<Value, Error> {
        self(cx)
    }
}

/// State shared by every request of one run.
pub(crate) struct Session {
    pub hello: Hello,
    #[cfg(feature = "api")]
    pub api: std::sync::OnceLock<Result<crate::api::Api, crate::api::ApiError>>,
}

impl Session {
    pub fn new(hello: Hello) -> Self {
        Self {
            hello,
            #[cfg(feature = "api")]
            api: std::sync::OnceLock::new(),
        }
    }
}

/// One request: its method, its params and the backend's `hello`.
pub struct Context {
    session: Arc<Session>,
    id: RequestId,
    method: String,
    params: Value,
}

impl Context {
    pub(crate) fn new(session: Arc<Session>, id: RequestId, method: String, params: Value) -> Self {
        Self {
            session,
            id,
            method,
            params,
        }
    }

    /// The `hello` the host sent at startup.
    pub fn hello(&self) -> &Hello {
        &self.session.hello
    }

    /// [`Hello::state_dir`]: the writable directory for this tab's state.
    /// Never write to the working directory.
    pub fn state_dir(&self) -> &Path {
        &self.session.hello.state_dir
    }

    pub fn id(&self) -> &RequestId {
        &self.id
    }

    pub fn method(&self) -> &str {
        &self.method
    }

    /// The params as sent (`null` when the caller passed none).
    pub fn raw_params(&self) -> &Value {
        &self.params
    }

    /// The params decoded as `T`; [`Error::invalid_params`] when they do not
    /// fit, so `cx.params::<T>()?` answers a bad call properly.
    pub fn params<T: DeserializeOwned>(&self) -> Result<T, Error> {
        T::deserialize(&self.params).map_err(Error::invalid_params)
    }

    /// A client for the Cadencr API with this backend's own token, created
    /// on first use and shared by every request.
    #[cfg(feature = "api")]
    pub fn api(&self) -> Result<&crate::api::Api, Error> {
        self.session
            .api
            .get_or_init(|| crate::api::Api::new(&self.session.hello.api))
            .as_ref()
            .map_err(|error| Error::from(error.clone()))
    }
}

#[cfg(test)]
mod tests {
    use serde::Deserialize;
    use serde_json::json;

    use super::*;
    use crate::error::codes;
    use crate::testing::sample_hello;

    #[derive(Deserialize)]
    struct Params {
        n: u32,
    }

    #[test]
    fn decodes_params_or_reports_them_invalid() {
        let session = Arc::new(Session::new(sample_hello()));
        let cx = |params| Context::new(session.clone(), "1".into(), "m".into(), params);
        assert_eq!(cx(json!({"n": 3})).params::<Params>().unwrap().n, 3);
        let error = cx(json!({"n": "x"})).params::<Params>().err().unwrap();
        assert_eq!(error.code(), codes::INVALID_PARAMS);
        assert_eq!(cx(Value::Null).hello().plugin.id, "example.tab");
        assert_eq!(cx(Value::Null).state_dir(), sample_hello().state_dir);
    }
}
