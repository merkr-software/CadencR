use crate::domain::agents::adapter::RuntimeSpawnConfig;
use crate::domain::agents::response_style::response_style_instruction;

const CODEX_INSTRUCTIONS: &str = r#"## Codex-specific Cadencr guidance

### Cadencr MCP tool names
Cadencr MCP tools may appear in either canonical or Codex namespace form. Treat these as equivalent:
- `mcp__cadencr-browser__browser_open_url` ↔ `mcp__cadencr_browser____browser_open_url`

When the prompt names canonical `mcp__cadencr-*__*` tools, use the matching
Codex namespace tool if that is the form exposed in your tool list.

### Links and embeds
Use only standard Markdown links (`[label](/abs/path/file.rs)` or `[label](rel/path/file.rs:42)`) and standard Markdown images (`![caption](/abs/path/image.png)`). Never emit Codex Desktop proprietary directives or widget tokens such as `:codex-file-citation{...}`, `::codex-inline-vis{...}`, or raw visualize tokens; Cadencr renders them as broken plain text.

### Delegated work completion
When authorized delegated work is required to complete the user's current
request, use the available agent-wait tool to collect the required results
before sending a final answer. Ending your turn does not guarantee that a
child's completion will start another parent turn. Do not finalize merely to
announce that required children are still working. This does not authorize
additional delegation, and does not prevent a status-only reply when the user
asks for one or an explicit background handoff."#;

pub(super) fn codex_developer_instructions(
    config: &RuntimeSpawnConfig,
    native_instructions: Option<&str>,
) -> Option<String> {
    let style = response_style_instruction(config)?;
    let native = native_instructions
        .map(str::trim)
        .filter(|value| !value.is_empty());

    Some(match native {
        Some(native) => format!("{native}\n\n{style}\n\n{CODEX_INSTRUCTIONS}"),
        None => format!("{style}\n\n{CODEX_INSTRUCTIONS}"),
    })
}

#[cfg(test)]
mod tests {
    use super::{codex_developer_instructions, CODEX_INSTRUCTIONS};
    use crate::domain::agents::adapter::{RuntimePurpose, RuntimeSpawnConfig};
    use crate::domain::agents::response_style::RICH_MARKDOWN_INSTRUCTION;

    #[test]
    fn codex_developer_instructions_include_markdown_links_and_mcp_guidance() {
        for native in [None, Some("   \n ")] {
            let instructions =
                codex_developer_instructions(&RuntimeSpawnConfig::default(), native).unwrap();

            assert!(instructions.starts_with(RICH_MARKDOWN_INSTRUCTION));
            assert!(instructions.contains("mcp__cadencr-browser__browser_open_url"));
            assert!(instructions.contains("mcp__cadencr_browser____browser_open_url"));
            assert!(instructions.contains(":codex-file-citation{...}"));
            assert!(instructions.contains("::codex-inline-vis{...}"));
            assert!(instructions.contains("before sending a final answer"));
            assert!(instructions.contains("does not authorize"));
        }
    }

    #[test]
    fn codex_developer_instructions_preserve_native_and_keep_rich_markdown() {
        let instructions =
            codex_developer_instructions(&RuntimeSpawnConfig::default(), Some("Native rule"))
                .unwrap();

        assert!(instructions.starts_with("Native rule\n\n"));
        assert!(instructions.contains(RICH_MARKDOWN_INSTRUCTION));
        assert!(instructions.ends_with(CODEX_INSTRUCTIONS));
    }

    #[test]
    fn auto_name_skips_codex_developer_instructions() {
        let config = RuntimeSpawnConfig {
            purpose: Some(RuntimePurpose::AutoName),
            ..RuntimeSpawnConfig::default()
        };
        assert_eq!(codex_developer_instructions(&config, None), None);
        assert_eq!(
            codex_developer_instructions(&config, Some("Native rule")),
            None
        );
    }
}
