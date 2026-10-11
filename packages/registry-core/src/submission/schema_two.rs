use super::*;

pub(super) fn validate_schema_two(value: &Value, errors: &mut Diagnostics) {
    let entry = &value["package"];
    crate::marketplace::validate(entry, "submission.package", errors);
    let content = crate::marketplace::body(entry);
    validate_source(value.get("source"), content, errors);
    if !value
        .get("changelog")
        .and_then(Value::as_str)
        .is_some_and(|s| {
            !ecmascript_trim(s).is_empty() && utf16_len(s) <= 16_384 && !s.contains('\0')
        })
    {
        errors.push("submission.changelog must be a bounded non-empty string".into());
    }
    if crate::marketplace::descriptor(entry).get("repository")
        != value.pointer("/source/repository")
    {
        errors.push("submission package repository must equal source repository".into());
    }
    if crate::marketplace::kind(entry) == "provider" {
        validate_marketplace_package(content, errors);
    } else if let (Some(archive), Some(repository), Some(tag)) = (
        content
            .pointer("/theme/distribution/archive")
            .and_then(Value::as_str),
        value.pointer("/source/repository").and_then(Value::as_str),
        value.pointer("/source/tag").and_then(Value::as_str),
    ) {
        validate_archive(
            archive,
            repository,
            tag,
            "submission.package.theme.distribution",
            errors,
        );
    }
}
