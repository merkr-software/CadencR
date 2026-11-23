use std::borrow::Cow;

use crate::domain::agents::adapter::{RuntimePurpose, RuntimeSpawnConfig};

pub(crate) const RICH_MARKDOWN_INSTRUCTION: &str = r#"Format every non-trivial response as ultra-rich GitHub-flavored Markdown.

Required response style:
- Use real Markdown headings (`##`, `###`) for every distinct section. Do not use bold-only pseudo-headings.
- Prefer structured formatting over prose blocks: lists, numbered steps, tables, blockquotes, task lists, and fenced code blocks.
- Use tables for comparisons, tradeoffs, option matrices, parameters, or before/after summaries.
- Use fenced code blocks with language tags for commands, code, JSON, diffs, config, and multi-line examples.
- Use inline code for identifiers, paths, commands, env vars, symbols, and literal values.
- When showing a local image or screenshot (`.png`, `.jpg`, `.gif`, `.webp`, `.svg`), embed it inline with standard Markdown image syntax (`![caption](/abs/path/to/image.png)` or a workspace-relative path; wrap paths with spaces in `<...>`) instead of only printing a file or folder path.
- Keep paragraphs short; split dense answers into scannable sections.
- Do not use raw HTML.

Example:

## Summary
- Item one
- Item two

## Comparison
| Option | Pros | Cons |
| --- | --- | --- |
| A | Fast | Limited |
| B | Complete | More work |

## Example
```ts
const ok = true;
```

## Checklist
- [x] Uses headings
- [x] Uses rich Markdown
- [x] Avoids HTML"#;

pub(crate) fn response_style_instruction(config: &RuntimeSpawnConfig) -> Option<&'static str> {
    if matches!(config.purpose, Some(RuntimePurpose::AutoName)) {
        return None;
    }
    Some(RICH_MARKDOWN_INSTRUCTION)
}

pub(crate) fn compose_response_style_prompt<'a>(
    config: &'a RuntimeSpawnConfig,
) -> Option<Cow<'a, str>> {
    let style = response_style_instruction(config);
    let base = config.trimmed_system_prompt();

    match (style, base) {
        (Some(style), Some(base)) => Some(Cow::Owned(format!("{style}\n\n{base}"))),
        (Some(style), None) => Some(Cow::Borrowed(style)),
        (None, Some(base)) => Some(Cow::Borrowed(base)),
        (None, None) => None,
    }
}

#[cfg(test)]
mod tests {
    use std::borrow::Cow;

    use super::{
        compose_response_style_prompt, response_style_instruction, RICH_MARKDOWN_INSTRUCTION,
    };
    use crate::domain::agents::adapter::{RuntimePurpose, RuntimeSpawnConfig};

    #[test]
    fn normal_sessions_prepend_rich_markdown_with_image_guidance() {
        let config = RuntimeSpawnConfig {
            system_prompt: Some("Base prompt".to_string()),
            ..RuntimeSpawnConfig::default()
        };
        let prompt = compose_response_style_prompt(&config).unwrap();
        assert!(prompt.starts_with(RICH_MARKDOWN_INSTRUCTION));
        assert!(prompt.contains("![caption](/abs/path/to/image.png)"));
        assert!(prompt.ends_with("Base prompt"));
    }

    #[test]
    fn normal_sessions_borrow_instruction_without_non_blank_base_prompt() {
        for system_prompt in [None, Some("   \n ".to_string())] {
            let config = RuntimeSpawnConfig {
                system_prompt,
                ..RuntimeSpawnConfig::default()
            };
            assert!(matches!(
                compose_response_style_prompt(&config),
                Some(Cow::Borrowed(RICH_MARKDOWN_INSTRUCTION))
            ));
        }
    }

    #[test]
    fn auto_name_skips_response_style_instruction() {
        let with_base = RuntimeSpawnConfig {
            purpose: Some(RuntimePurpose::AutoName),
            system_prompt: Some("  Name this session.  ".to_string()),
            ..RuntimeSpawnConfig::default()
        };
        assert_eq!(response_style_instruction(&with_base), None);
        assert!(matches!(
            compose_response_style_prompt(&with_base),
            Some(Cow::Borrowed("Name this session."))
        ));

        for system_prompt in [None, Some("  \t ".to_string())] {
            let without_base = RuntimeSpawnConfig {
                purpose: Some(RuntimePurpose::AutoName),
                system_prompt,
                ..RuntimeSpawnConfig::default()
            };
            assert_eq!(compose_response_style_prompt(&without_base), None);
        }
    }
}
