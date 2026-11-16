use super::*;

impl GitHubClient {
    pub(super) fn paged<T: for<'de> Deserialize<'de>>(
        &self,
        noun: &str,
        path: &str,
    ) -> Result<Vec<T>, PublisherError> {
        self.paged_before(noun, path, None)
    }

    /// Like [`Self::paged`], every page request bounded by `deadline`.
    pub(super) fn paged_before<T: for<'de> Deserialize<'de>>(
        &self,
        noun: &str,
        path: &str,
        deadline: Option<Instant>,
    ) -> Result<Vec<T>, PublisherError> {
        let mut result = Vec::new();
        for page in 1..=MAX_PAGES {
            let separator = if path.contains('?') { '&' } else { '?' };
            let values: Vec<T> = self.request.get_with_deadline(
                &format!("{path}{separator}per_page={PAGE_SIZE}&page={page}"),
                deadline,
            )?;
            let count = values.len();
            if count > PAGE_SIZE {
                return Err(error(format!("GitHub {noun} response is malformed")));
            }
            result.extend(values);
            if count < PAGE_SIZE {
                return Ok(result);
            }
        }
        Err(error(format!("GitHub {noun} pagination limit exceeded")))
    }

    pub(super) fn release_by_id(&self, release_id: u64) -> Result<Option<Release>, PublisherError> {
        id(release_id, "release id")?;
        self.request
            .get_optional::<RawRelease>(&format!(
                "/repos/{}/releases/{release_id}",
                self.repository
            ))?
            .map(Release::try_from)
            .transpose()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::github::fixture::{client, serve_json};

    #[test]
    fn direct_lookup_is_authenticated_fixed_id_and_missing_is_none() {
        let body = r#"{"id":7,"draft":true,"prerelease":false,"tag_name":"v1","target_commitish":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","body":"binding"}"#;
        let (api, observed) = serve_json("200 OK", body);
        assert_eq!(client(api).get_release(7).unwrap().unwrap().id, 7);
        let request = observed.join().unwrap();
        assert!(request.starts_with("GET /repos/acme/releases/releases/7 HTTP/1.1"));
        assert!(request.contains("authorization: Bearer secret-token"));
        let (api, observed) = serve_json("404 Not Found", "{}");
        assert!(client(api).get_release(7).unwrap().is_none());
        observed.join().unwrap();
    }
}
