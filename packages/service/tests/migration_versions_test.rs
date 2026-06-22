use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

#[test]
fn migration_versions_are_unique() {
    let migrations_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("migrations");
    let mut files_by_version: BTreeMap<String, Vec<String>> = BTreeMap::new();

    for entry in fs::read_dir(&migrations_dir).expect("migrations directory should be readable") {
        let entry = entry.expect("migration directory entry should be readable");
        let file_name = entry.file_name().to_string_lossy().into_owned();
        if !file_name.ends_with(".sql") {
            continue;
        }

        let Some((version, _description)) = file_name.split_once('_') else {
            continue;
        };
        files_by_version
            .entry(version.to_string())
            .or_default()
            .push(file_name);
    }

    let duplicates: Vec<String> = files_by_version
        .into_iter()
        .filter_map(|(version, files)| {
            (files.len() > 1).then(|| format!("{version}: {}", files.join(", ")))
        })
        .collect();

    assert!(
        duplicates.is_empty(),
        "duplicate sqlx migration version(s): {}",
        duplicates.join("; ")
    );
}
