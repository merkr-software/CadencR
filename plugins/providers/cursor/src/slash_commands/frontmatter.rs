//! The `SKILL.md` frontmatter Cursor reads, split and parsed the way its
//! loader does (gray-matter + js-yaml), for the fields that decide what it
//! lists: `name`, `description`, `user-invocable`, `metadata.surfaces`.
//!
//! This is a YAML subset: block mappings and sequences, plain / quoted /
//! block (`|`, `>`) scalars and flow sequences. YAML errors Cursor would hit
//! (duplicate keys, `: ` inside a plain scalar, unterminated quotes, bad
//! indentation) are errors here too, so the skill is skipped like in Cursor.

mod scalars;

use scalars::{
    check_plain, closing_quote, flow_sequence, fold, resolve_plain, strip_comment, unquote,
};

/// One parsed YAML node, typed like js-yaml's default schema.
#[derive(Debug, Clone, PartialEq)]
enum Node {
    Null,
    Bool(bool),
    Number,
    Str(String),
    Seq(Vec<Node>),
    Map(Vec<(String, Node)>),
    /// Anchors, aliases, tags, flow mappings: not read here.
    Other,
}

/// What a skill's frontmatter says about its listing.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct SkillFrontmatter {
    pub name: Option<String>,
    pub description: Option<String>,
    /// `user-invocable: false` (or the string `"false"`): hidden.
    pub not_user_invocable: bool,
    /// `metadata.surfaces`; hidden from the CLI when non-empty without `cli`.
    pub surfaces: Vec<String>,
}

/// gray-matter's split: `(frontmatter text, body)`; no frontmatter → `None`.
pub fn split(content: &str) -> (Option<&str>, &str) {
    let Some(rest) = content.strip_prefix("---") else {
        return (None, content);
    };
    if rest.starts_with('-') {
        return (None, content);
    }
    // Text after the opening `---` on its line names a language; skipped.
    let rest = rest.find('\n').map_or("", |newline| &rest[newline..]);
    match rest.find("\n---") {
        None => (Some(rest), ""),
        Some(close) => {
            let body = &rest[close + 4..];
            let body = body.strip_prefix('\r').unwrap_or(body);
            (
                Some(&rest[..close]),
                body.strip_prefix('\n').unwrap_or(body),
            )
        }
    }
}

pub fn parse(matter: &str) -> Result<SkillFrontmatter, String> {
    let lines: Vec<&str> = matter
        .split('\n')
        .map(|line| line.strip_suffix('\r').unwrap_or(line))
        .collect();
    let mut parser = Parser { lines, pos: 0 };
    parser.skip_blank();
    let root = match parser.peek() {
        None => return Ok(SkillFrontmatter::default()),
        Some(line) if indent_of(line) > 0 => return Err("unexpected indentation".into()),
        Some(line) if is_sequence_item(line.trim_start()) => parser.sequence(0)?,
        Some(_) => Node::Map(parser.mapping(0)?),
    };
    parser.skip_blank();
    if parser.peek().is_some() {
        return Err("unexpected content after the document".into());
    }
    let Node::Map(entries) = root else {
        return Ok(SkillFrontmatter::default());
    };
    let field = |key: &str| entries.iter().find(|(name, _)| name == key).map(|e| &e.1);
    let string = |key: &str| match field(key) {
        Some(Node::Str(value)) => Some(value.clone()),
        _ => None,
    };
    Ok(SkillFrontmatter {
        name: string("name"),
        description: string("description"),
        not_user_invocable: match field("user-invocable") {
            Some(Node::Bool(false)) => true,
            Some(Node::Str(value)) => value.trim().eq_ignore_ascii_case("false"),
            _ => false,
        },
        surfaces: match field("metadata") {
            Some(Node::Map(metadata)) => surfaces(metadata),
            _ => Vec::new(),
        },
    })
}

fn surfaces(metadata: &[(String, Node)]) -> Vec<String> {
    match metadata
        .iter()
        .find(|(key, _)| key == "surfaces")
        .map(|e| &e.1)
    {
        Some(Node::Seq(items)) => items
            .iter()
            .filter_map(|item| match item {
                Node::Str(value) => Some(value.clone()),
                _ => None,
            })
            .collect(),
        Some(Node::Str(value)) => value
            .split(',')
            .map(str::trim)
            .filter(|surface| !surface.is_empty())
            .map(str::to_string)
            .collect(),
        _ => Vec::new(),
    }
}

struct Parser<'a> {
    lines: Vec<&'a str>,
    pos: usize,
}

fn indent_of(line: &str) -> usize {
    line.len() - line.trim_start_matches(' ').len()
}

fn is_blank(line: &str) -> bool {
    let trimmed = line.trim();
    trimmed.is_empty() || trimmed.starts_with('#')
}

fn is_sequence_item(text: &str) -> bool {
    text == "-" || text.starts_with("- ")
}

/// `key: rest` (or `key:`), with a plain or quoted key.
fn split_key(text: &str) -> Option<(String, &str)> {
    if let Some(quote) = text.chars().next().filter(|c| *c == '"' || *c == '\'') {
        let close = text[1..].find(quote)? + 1;
        let after = text[close + 1..].strip_prefix(':')?;
        if !(after.is_empty() || after.starts_with(' ')) {
            return None;
        }
        return Some((text[1..close].to_string(), after.trim_start()));
    }
    let colon = text
        .char_indices()
        .find(|&(index, ch)| ch == ':' && text[index + 1..].chars().next().is_none_or(|c| c == ' '))
        .map(|(index, _)| index)?;
    let key = text[..colon].trim_end();
    (!key.is_empty() && !key.starts_with('#'))
        .then(|| (key.to_string(), text[colon + 1..].trim_start()))
}

impl<'a> Parser<'a> {
    fn peek(&self) -> Option<&'a str> {
        self.lines.get(self.pos).copied()
    }

    fn skip_blank(&mut self) {
        while self.peek().is_some_and(is_blank) {
            self.pos += 1;
        }
    }

    /// The next meaningful line, if it is indented deeper than `indent`.
    fn deeper(&mut self, indent: usize) -> Option<&'a str> {
        let saved = self.pos;
        self.skip_blank();
        match self.peek() {
            Some(line) if indent_of(line) > indent => Some(line),
            _ => {
                self.pos = saved;
                None
            }
        }
    }

    fn mapping(&mut self, indent: usize) -> Result<Vec<(String, Node)>, String> {
        let mut entries: Vec<(String, Node)> = Vec::new();
        loop {
            self.skip_blank();
            let Some(line) = self.peek() else { break };
            let line_indent = indent_of(line);
            if line_indent < indent {
                break;
            }
            if line_indent > indent {
                return Err("bad indentation of a mapping entry".into());
            }
            let text = &line[indent..];
            if is_sequence_item(text) {
                break;
            }
            let (key, rest) = split_key(text).ok_or("expected a `key: value` entry")?;
            self.pos += 1;
            let value = self.value(rest, indent)?;
            if entries.iter().any(|(existing, _)| *existing == key) {
                return Err(format!("duplicated mapping key `{key}`"));
            }
            entries.push((key, value));
        }
        Ok(entries)
    }

    fn sequence(&mut self, indent: usize) -> Result<Node, String> {
        let mut items = Vec::new();
        loop {
            self.skip_blank();
            let Some(line) = self.peek() else { break };
            if indent_of(line) != indent || !is_sequence_item(&line[indent..]) {
                break;
            }
            self.pos += 1;
            let rest = line[indent + 1..].trim_start();
            items.push(match split_key(rest) {
                // `- key: value` items are mappings; not read here.
                Some(_) => {
                    while self.deeper(indent).is_some() {
                        self.pos += 1;
                    }
                    Node::Other
                }
                None => self.value(rest, indent)?,
            });
        }
        Ok(Node::Seq(items))
    }

    /// The value after `key:` on a line indented `indent`.
    fn value(&mut self, rest: &str, indent: usize) -> Result<Node, String> {
        let rest = rest.trim_end();
        match rest.chars().next() {
            None | Some('#') => self.nested(indent),
            Some('|' | '>') => Ok(Node::Str(self.block_scalar(rest, indent)?)),
            Some(quote @ ('"' | '\'')) => Ok(Node::Str(self.quoted(rest, quote, indent)?)),
            Some('[') => flow_sequence(rest),
            Some('{' | '&' | '*' | '!') => {
                while self.deeper(indent).is_some() {
                    self.pos += 1;
                }
                Ok(Node::Other)
            }
            Some('@' | '`') => Err(format!("a plain scalar cannot start with {rest:?}")),
            Some(_) if is_sequence_item(rest) => {
                Err("sequence entries are not allowed here".into())
            }
            Some(_) => self.plain(rest, indent),
        }
    }

    fn nested(&mut self, indent: usize) -> Result<Node, String> {
        let saved = self.pos;
        self.skip_blank();
        let Some(line) = self.peek() else {
            return Ok(Node::Null);
        };
        let child = indent_of(line);
        let text = &line[child..];
        if child == indent && is_sequence_item(text) {
            return self.sequence(indent);
        }
        if child <= indent {
            self.pos = saved;
            return Ok(Node::Null);
        }
        if is_sequence_item(text) {
            return self.sequence(child);
        }
        if split_key(text).is_some() {
            return Ok(Node::Map(self.mapping(child)?));
        }
        self.pos = saved;
        self.plain("", indent)
    }

    /// A plain scalar starting with `first`, continued on deeper lines.
    fn plain(&mut self, first: &str, indent: usize) -> Result<Node, String> {
        let first = strip_comment(first);
        let mut text = first.trim().to_string();
        check_plain(&text)?;
        let multi_line = text.is_empty();
        let mut breaks = 0;
        while let Some(line) = self.peek() {
            if line.trim().is_empty() {
                breaks += 1;
                self.pos += 1;
                continue;
            }
            if indent_of(line) <= indent || line.trim_start().starts_with('#') {
                break;
            }
            let part = strip_comment(line.trim());
            check_plain(part)?;
            if !text.is_empty() {
                text.push_str(&if breaks > 0 {
                    "\n".repeat(breaks)
                } else {
                    " ".into()
                });
            }
            text.push_str(part.trim());
            breaks = 0;
            self.pos += 1;
        }
        if multi_line && text.is_empty() {
            return Ok(Node::Null);
        }
        Ok(resolve_plain(text))
    }

    fn quoted(&mut self, first: &str, quote: char, indent: usize) -> Result<String, String> {
        let mut raw = first[1..].to_string();
        loop {
            if let Some(end) = closing_quote(&raw, quote) {
                let trailing = strip_comment(&raw[end + 1..]).trim();
                if !trailing.is_empty() {
                    return Err(format!(
                        "unexpected text after a quoted scalar: {trailing:?}"
                    ));
                }
                raw.truncate(end);
                return Ok(unquote(&raw, quote));
            }
            let Some(line) = self
                .peek()
                .filter(|line| line.trim().is_empty() || indent_of(line) > indent)
            else {
                return Err("unterminated quoted scalar".into());
            };
            self.pos += 1;
            raw.push('\n');
            raw.push_str(line.trim());
        }
    }

    fn block_scalar(&mut self, header: &str, indent: usize) -> Result<String, String> {
        let header = strip_comment(header).trim();
        let folded = header.starts_with('>');
        let mut chomp = '\0';
        let mut explicit = None;
        for ch in header[1..].chars() {
            match ch {
                '-' | '+' => chomp = ch,
                '1'..='9' => explicit = ch.to_digit(10).map(|digit| indent + digit as usize),
                _ => return Err(format!("invalid block scalar header {header:?}")),
            }
        }
        let mut lines = Vec::new();
        let mut content_indent = explicit;
        while let Some(line) = self.peek() {
            if line.trim().is_empty() {
                lines.push("");
                self.pos += 1;
                continue;
            }
            let line_indent = indent_of(line);
            let required = *content_indent.get_or_insert(line_indent);
            if line_indent <= indent || line_indent < required {
                break;
            }
            lines.push(&line[required..]);
            self.pos += 1;
        }
        let trailing = lines
            .iter()
            .rev()
            .take_while(|line| line.is_empty())
            .count();
        let body = &lines[..lines.len() - trailing];
        let mut text = if folded { fold(body) } else { body.join("\n") };
        if !body.is_empty() {
            match chomp {
                '-' => {}
                '+' => text.push_str(&"\n".repeat(trailing + 1)),
                _ => text.push('\n'),
            }
        }
        Ok(text)
    }
}

#[cfg(test)]
mod tests {
    use super::{parse, split, SkillFrontmatter};

    fn front(content: &str) -> Result<SkillFrontmatter, String> {
        let (matter, _) = split(content);
        parse(matter.expect("frontmatter"))
    }

    #[test]
    fn splits_like_gray_matter() {
        assert_eq!(split("no frontmatter"), (None, "no frontmatter"));
        assert_eq!(split("----\nx"), (None, "----\nx"));
        assert_eq!(
            split("---\nname: a\n---\nbody\n"),
            (Some("\nname: a"), "body\n")
        );
        assert_eq!(
            split("---\r\nname: a\r\n---\r\nbody"),
            (Some("\nname: a\r"), "body")
        );
        assert_eq!(split("---\nname: a\n"), (Some("\nname: a\n"), ""));
    }

    #[test]
    fn reads_scalars_the_way_js_yaml_types_them() {
        let parsed = front(
            "---\nname: other-name\ndescription: >-\n  Multi line\n  folded description\n---\n",
        )
        .unwrap();
        assert_eq!(parsed.name.as_deref(), Some("other-name"));
        assert_eq!(
            parsed.description.as_deref(),
            Some("Multi line folded description")
        );
        let literal = front("---\ndescription: |\n  Literal line one\n  line two\n---\n").unwrap();
        assert_eq!(
            literal.description.as_deref(),
            Some("Literal line one\nline two\n")
        );
        let quoted = front("---\ndescription: \"Quoted: nested \\\"deep\\\"\"\n---\n").unwrap();
        assert_eq!(
            quoted.description.as_deref(),
            Some("Quoted: nested \"deep\"")
        );
        let single = front("---\ndescription: 'it''s'\n---\n").unwrap();
        assert_eq!(single.description.as_deref(), Some("it's"));
        let plain = front("---\ndescription: Plain text # comment\n  continued\n---\n").unwrap();
        assert_eq!(plain.description.as_deref(), Some("Plain text continued"));
        for value in ["123", "true", "~", "", "1.5"] {
            let typed = front(&format!("---\ndescription: {value}\n---\n")).unwrap();
            assert_eq!(typed.description, None, "{value}");
        }
    }

    #[test]
    fn reads_invocability_and_surfaces() {
        let hidden = front("---\nuser-invocable: false\n---\n").unwrap();
        assert!(hidden.not_user_invocable);
        assert!(
            front("---\nuser-invocable: ' False '\n---\n")
                .unwrap()
                .not_user_invocable
        );
        assert!(
            !front("---\nuser-invocable: no\n---\n")
                .unwrap()
                .not_user_invocable
        );
        let block = front("---\nmetadata:\n  surfaces:\n    - ide\n    - cli\n---\n").unwrap();
        assert_eq!(block.surfaces, ["ide", "cli"]);
        let same_indent = front("---\nmetadata:\n  surfaces:\n  - ide\n---\n").unwrap();
        assert_eq!(same_indent.surfaces, ["ide"]);
        let flow = front("---\nmetadata:\n  surfaces: [ide, \"cli\"]\n---\n").unwrap();
        assert_eq!(flow.surfaces, ["ide", "cli"]);
        let csv = front("---\nmetadata:\n  surfaces: ide, web\n---\n").unwrap();
        assert_eq!(csv.surfaces, ["ide", "web"]);
    }

    #[test]
    fn yaml_errors_cursor_would_hit_are_errors() {
        for content in [
            "---\nname: a\nname: b\n---\n",
            "---\ndescription: Use when: testing\n---\n",
            "---\ndescription: \"unterminated\n---\n",
            "---\n  indented: first\n---\n",
            "---\ndescription: - item\n---\n",
            "---\njust text\n---\n",
        ] {
            assert!(front(content).is_err(), "{content:?}");
        }
    }
}
