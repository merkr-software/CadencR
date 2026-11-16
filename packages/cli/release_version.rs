pub fn resolve<'a>(
    base: &'a str,
    override_version: Option<&'a str>,
) -> Result<&'a str, &'static str> {
    let Some(version) = override_version else {
        return Ok(base);
    };
    let base_parts: Vec<_> = base.split('.').collect();
    if base_parts.len() != 3
        || base_parts.iter().any(|part| {
            part.is_empty()
                || (part.len() > 1 && part.starts_with('0'))
                || !part.bytes().all(|byte| byte.is_ascii_digit())
        })
    {
        return Err("expected stable package version base");
    }
    let suffix = version
        .strip_prefix(base)
        .and_then(|value| value.strip_prefix("-dev."))
        .ok_or("wrong version base or channel")?;
    let parts: Vec<_> = suffix.split('.').collect();
    if parts.len() != 2
        || parts.iter().any(|value| {
            value.is_empty()
                || value.starts_with('0')
                || !value.bytes().all(|byte| byte.is_ascii_digit())
        })
    {
        return Err("expected positive canonical run id and attempt");
    }
    Ok(version)
}

#[cfg(test)]
mod tests {
    use super::resolve;

    #[test]
    fn normal_and_dev_versions() {
        assert_eq!(resolve("0.13.1", None), Ok("0.13.1"));
        assert_eq!(
            resolve("0.13.1", Some("0.13.1-dev.123.1")),
            Ok("0.13.1-dev.123.1")
        );
        for invalid in [
            "",
            "0.13.2-dev.123.1",
            "0.13.1",
            "0.13.1-dev.0.1",
            "0.13.1-dev.01.1",
            "0.13.1-dev.1.1.extra",
            "0.13.1-dev.1.1\n",
            "0.13.1-dev.1.1+meta",
        ] {
            assert!(resolve("0.13.1", Some(invalid)).is_err(), "{invalid}");
        }
    }
}
