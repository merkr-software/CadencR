//! Reading which registry package an installed server runs, from the launch
//! command its CLI reports, and swapping that package's version for an update.

use super::mcp_options::package_token;
use super::types::McpPackageRef;

/// The package argument of a `npx`/`bunx`/`uvx` launch and where it sits.
pub fn package_in_launch(command: &str, args: &[String]) -> Option<(usize, McpPackageRef)> {
    let launcher = std::path::Path::new(command)
        .file_name()?
        .to_string_lossy()
        .into_owned();
    let registry_type = match launcher.as_str() {
        "npx" | "bunx" => "npm",
        "uvx" => "pypi",
        _ => return None,
    };
    let (index, token) = args
        .iter()
        .enumerate()
        .find(|(_, arg)| !arg.starts_with('-'))?;
    let (identifier, version) = match registry_type {
        "npm" => split_npm(token),
        _ => split_pypi(token),
    };
    if identifier.is_empty() {
        return None;
    }
    Some((
        index,
        McpPackageRef {
            registry_type: registry_type.to_string(),
            identifier: identifier.to_string(),
            version: version
                .filter(|version| is_pinned(version))
                .map(str::to_string),
        },
    ))
}

/// `@scope/name@1.2.3` → (`@scope/name`, `1.2.3`).
fn split_npm(token: &str) -> (&str, Option<&str>) {
    match token.rfind('@') {
        Some(at) if at > 0 => (&token[..at], Some(&token[at + 1..])),
        _ => (token, None),
    }
}

/// `name==1.2.3` or `name@1.2.3` → (`name`, `1.2.3`).
fn split_pypi(token: &str) -> (&str, Option<&str>) {
    if let Some((name, version)) = token.split_once("==") {
        return (name, Some(version));
    }
    match token.split_once('@') {
        Some((name, version)) => (name, Some(version)),
        None => (token, None),
    }
}

/// A concrete version, not a dist-tag such as `latest` or a range.
fn is_pinned(version: &str) -> bool {
    version.chars().next().is_some_and(|ch| ch.is_ascii_digit())
        && version
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ".-+".contains(ch))
}

/// `args` with the package at `index` moved to `version`.
pub fn with_version(
    args: &[String],
    index: usize,
    package: &McpPackageRef,
    version: &str,
) -> Vec<String> {
    let mut updated = args.to_vec();
    if let Some(slot) = updated.get_mut(index) {
        *slot = package_token(&package.registry_type, &package.identifier, Some(version));
    }
    updated
}

/// Whether arguments read back from a space-joined line may have held a
/// space: two bare words in a row, the package token aside (a split value
/// always leaves two).
pub fn may_hold_spaces(args: &[String], package_index: usize) -> bool {
    let bare = |index: usize| index != package_index && !args[index].starts_with('-');
    (1..args.len()).any(|index| bare(index - 1) && bare(index))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strings(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    #[test]
    fn reads_pinned_and_floating_npm_packages() {
        let (index, package) =
            package_in_launch("npx", &strings(&["-y", "@acme/mcp@2.1.0", "serve"])).unwrap();
        assert_eq!(index, 1);
        assert_eq!(package.identifier, "@acme/mcp");
        assert_eq!(package.version.as_deref(), Some("2.1.0"));
        let (_, floating) =
            package_in_launch("/usr/bin/npx", &strings(&["chrome-devtools-mcp@latest"])).unwrap();
        assert_eq!(floating.identifier, "chrome-devtools-mcp");
        assert_eq!(floating.version, None);
    }

    #[test]
    fn reads_pypi_packages_and_ignores_other_commands() {
        let (_, package) = package_in_launch("uvx", &strings(&["medium-ops==0.1.2"])).unwrap();
        assert_eq!(package.registry_type, "pypi");
        assert_eq!(package.version.as_deref(), Some("0.1.2"));
        assert!(package_in_launch("codegraph", &strings(&["serve", "--mcp"])).is_none());
    }

    #[test]
    fn spots_arguments_a_space_may_have_split() {
        let flags = strings(&["-y", "fs@1.0.0", "--root", "/tmp", "--port", "8080"]);
        assert!(!may_hold_spaces(&flags, 1));
        assert!(!may_hold_spaces(&strings(&["-y", "fs@1.0.0", "/tmp"]), 1));
        assert!(may_hold_spaces(
            &strings(&["-y", "fs@1.0.0", "/Users/me/My", "Projects"]),
            1
        ));
    }

    #[test]
    fn swaps_only_the_package_version() {
        let args = strings(&["-y", "@acme/mcp@2.1.0", "--flag"]);
        let (index, package) = package_in_launch("npx", &args).unwrap();
        assert_eq!(
            with_version(&args, index, &package, "2.2.0"),
            strings(&["-y", "@acme/mcp@2.2.0", "--flag"])
        );
    }
}
