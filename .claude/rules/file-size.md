Max 400 lines per file — past that, split into modules/components so files stay reviewable.
(test files exempt; enforced by oxlint `max-lines` — see .oxlintrc.json. Rust `.rs` files are checked by the PostToolUse hook in .claude/settings.json.)
