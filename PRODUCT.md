# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

(Electron desktop shell rendering a React SPA; the same renderer is served to phones over the remote-access mode, so layouts must hold below 768px.)

## Users

Senior individual contributors and tech leads who run several AI coding agents (Claude Code, Codex, Cursor, OpenCode, ACP connectors) in parallel, across projects and git worktrees. They read code, know what a worktree is, and prefer dense, keyboard-driven IDEs over chat-style UIs. A smaller audience are plugin authors who build themes and provider connectors inside their own Cadencr instance.

## Product Purpose

Cadencr is a desktop IDE that wraps multiple AI coding agents behind one workspace: each feature gets its own worktree and agent session, with agent transcript, terminal, git diff and editor side by side. Success is supervising many agents faster and more safely than terminals and chat threads allow.

## Positioning

Provider-neutral workspace: Cadencr is the supervision surface, not a model vendor. Extensibility (themes, bring-your-own ACP agents, custom tabs) keeps it neutral, with signed, verified distribution rather than arbitrary third-party code in the renderer.

## Operating Context

Long sessions on a desktop monitor, often next to a terminal and a browser; the app is the primary workspace all day. Remote access from a phone exists for checking and answering agents.

## Capabilities and Constraints

- Marketplace (visible in every build; browsing and installing need the catalog feed compiled into the service): a signed, verified catalog that today serves **themes** and **provider connectors**, each package one kind. Install, update, enable/disable, remove, restart-required state, history, quarantine, signing trust and blocklist diagnostics exist.
- Target content kinds for the marketplace (user, 2026-10-17): MCP servers, skills, themes, providers, custom tabs, custom pages; one plugin may contribute several kinds. Only kinds the catalog actually serves may be shown — no placeholder categories or fabricated listings (user decision 2026-10-17: this iteration covers what the catalog serves).
- The marketplace is for discovery and management; author publication flows stay outside it (user decision 2026-10-17).
- Signed revisions are immutable; installation and activation are separate choices.
- Never invent ratings, download counts, reviews or popularity: the catalog carries none.

## Brand Commitments

Name: CadencR (wordmark CADENCR). Brand direction "Emerald Reserve" with the "Index Dots" logo; visual system recorded in DESIGN.md.

## Product Principles

1. Supervision first: every surface must make state legible at a glance.
2. Provider neutrality: no vendor is privileged in layout or color.
3. Trust is shown, not claimed: verification, signing and restart requirements stay visible where they affect a decision.
4. Dense but calm: information density for experts, without noise.
