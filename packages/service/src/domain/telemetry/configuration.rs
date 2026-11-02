use reqwest::Url;

use super::models::safe_token;

pub(super) struct Configuration {
    pub sentry: Option<SentryTarget>,
    pub posthog: Option<(Url, String)>,
    pub release: String,
}

pub(super) struct SentryTarget {
    pub endpoint: Url,
    pub key: String,
}

fn value(name: &str, built: Option<&str>) -> Option<String> {
    std::env::var(name)
        .ok()
        .or_else(|| built.map(str::to_owned))
        .filter(|value| !value.trim().is_empty())
}

impl Configuration {
    pub fn from_env(app_version: Option<&str>) -> Self {
        let enabled = !cfg!(debug_assertions)
            || std::env::var("CADENCR_TELEMETRY_DEV_ENABLED").as_deref() == Ok("true");
        let allow_local = cfg!(debug_assertions)
            && std::env::var("CADENCR_TELEMETRY_ALLOW_LOCAL_TESTING").as_deref() == Ok("1");
        let version = app_version
            .filter(|value| safe_token(value))
            .unwrap_or(env!("CARGO_PKG_VERSION"));
        Self {
            sentry: enabled
                .then(|| value("CADENCR_SENTRY_DSN", option_env!("CADENCR_SENTRY_DSN")))
                .flatten()
                .and_then(|dsn| sentry_target(&dsn, allow_local)),
            posthog: enabled
                .then(|| value("CADENCR_POSTHOG_KEY", option_env!("CADENCR_POSTHOG_KEY")))
                .flatten()
                .and_then(|key| {
                    let host = value("CADENCR_POSTHOG_HOST", option_env!("CADENCR_POSTHOG_HOST"))
                        .unwrap_or_else(|| "https://eu.i.posthog.com".into());
                    let mut url = Url::parse(&host).ok()?;
                    if !allowed_url(&url, allow_local) || url.path() != "/" {
                        return None;
                    }
                    url.set_path("/i/v0/e/");
                    Some((url, key))
                }),
            release: format!("cadencr@{version}"),
        }
    }
}

fn allowed_url(url: &Url, allow_local: bool) -> bool {
    url.username().is_empty()
        && url.password().is_none()
        && url.query().is_none()
        && url.fragment().is_none()
        && url.host_str().is_some()
        && (url.scheme() == "https"
            || (allow_local
                && url.scheme() == "http"
                && matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"))))
}

fn sentry_target(dsn: &str, allow_local: bool) -> Option<SentryTarget> {
    let mut url = Url::parse(dsn).ok()?;
    let key = url.username().to_owned();
    if !safe_token(&key) || url.password().is_some() {
        return None;
    }
    url.set_username("").ok()?;
    if !allowed_url(&url, allow_local) {
        return None;
    }
    let path = url.path().trim_end_matches('/');
    let (prefix, project) = path.rsplit_once('/')?;
    if project.is_empty() || !project.bytes().all(|c| c.is_ascii_digit()) {
        return None;
    }
    url.set_path(&format!("{prefix}/api/{project}/envelope/"));
    Some(SentryTarget { endpoint: url, key })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg(debug_assertions)]
    fn shared_posthog_configuration_requires_debug_opt_in_and_safe_target() {
        use crate::shared::test_env::{env_lock, EnvVarGuard};
        let _lock = env_lock().lock().unwrap_or_else(|p| p.into_inner());
        let _key = EnvVarGuard::set("CADENCR_POSTHOG_KEY", "public-key");
        let _host = EnvVarGuard::set("CADENCR_POSTHOG_HOST", "https://eu.i.posthog.com");
        let _disabled = EnvVarGuard::set("CADENCR_TELEMETRY_DEV_ENABLED", "false");
        assert!(Configuration::from_env(None).posthog.is_none());
        let _enabled = EnvVarGuard::set("CADENCR_TELEMETRY_DEV_ENABLED", "true");
        let configured = Configuration::from_env(None).posthog.unwrap();
        assert_eq!(configured.0.as_str(), "https://eu.i.posthog.com/i/v0/e/");
        let _local = EnvVarGuard::set("CADENCR_POSTHOG_HOST", "http://127.0.0.1:1234");
        let _disallow_local = EnvVarGuard::set("CADENCR_TELEMETRY_ALLOW_LOCAL_TESTING", "");
        assert!(Configuration::from_env(None).posthog.is_none());
        let _allow_local = EnvVarGuard::set("CADENCR_TELEMETRY_ALLOW_LOCAL_TESTING", "1");
        assert!(Configuration::from_env(None).posthog.is_some());
        let _unsafe = EnvVarGuard::set("CADENCR_POSTHOG_HOST", "https://user:secret@example.com");
        assert!(Configuration::from_env(None).posthog.is_none());
        let _no_key = EnvVarGuard::set("CADENCR_POSTHOG_KEY", "");
        assert!(Configuration::from_env(None).posthog.is_none());
    }

    #[test]
    fn production_requires_https_and_no_ambient_credentials_or_urls() {
        assert!(sentry_target("https://public@o1.ingest.sentry.io/42", false).is_some());
        assert!(sentry_target("http://public@127.0.0.1:9999/42", false).is_none());
        assert!(sentry_target("http://public@127.0.0.1:9999/42", true).is_some());
        assert!(sentry_target("http://public@example.com/42", true).is_none());
        assert!(sentry_target("https://public:secret@example.com/42", false).is_none());
        assert!(sentry_target("https://public@example.com/42?secret=x", false).is_none());
        assert!(!allowed_url(
            &Url::parse("https://user:secret@example.com").unwrap(),
            false
        ));
    }
}
