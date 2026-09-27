pub fn submission() -> serde_json::Value {
    let repository = "https://github.com/acme/provider";
    serde_json::json!({
        "schema_version": 1,
        "package": {
            "agent": {
                "id": "acme-agent", "name": "Acme Agent", "version": "1.2.3",
                "description": "ACP connector", "license": "Apache-2.0",
                "repository": repository,
                "distribution": { "binary": { "linux-x86_64": {
                    "archive": format!("{repository}/releases/download/v1.2.3/provider.tgz"),
                    "cmd": "bin/provider", "sha256": "a".repeat(64)
                }}}
            },
            "host": {
                "publisher": "acme",
                "compatibility": { "min_app_version": "0.12.0" },
                "assets": { "icon": "icon.svg", "readme": "README.md", "license": "LICENSE" }
            }
        },
        "source": { "repository": repository, "commit": "1".repeat(40), "tag": "v1.2.3" },
        "changelog": "Release notes."
    })
}
