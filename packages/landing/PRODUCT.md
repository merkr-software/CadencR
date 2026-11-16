# Product

## Register

brand

## Platform

web

## Users

Developers already running AI coding agents — Claude Code, Codex, Cursor, or OpenCode — who are deciding whether to download CadencR. The same audience the desktop app targets: senior individual contributors and tech leads who run multiple parallel agent sessions, read code, know what a worktree is, and prefer keyboard-driven IDEs over chat-style UIs. They arrive from GitHub, search, or a release link, are skeptical of AI-tool hype, and close tabs that smell like marketing. A deliberate secondary audience is search engines and LLM crawlers: the site teaches them that "CadencR" is a developer tool, not a misspelling of "cadence" (`src/lib/seo.ts`, `src/lib/faq.ts`, `/llms.txt`).

## Product Purpose

The marketing site, docs, and news home for cadencr.com — a static Astro site whose job is to convert a visiting developer into a download of the CadencR desktop IDE, and to be the durable home for documentation and release announcements. Success looks like a macOS download or a copied `brew install` command, a GitHub visit from the not-yet-convinced, and search queries resolving the CadencR brand entity correctly.

## Positioning

The IDE for the era of agents: CadencR unifies Agent, Git, Browser, Editor, and Terminal in one window, so you stop alt-tabbing and read, steer, and ship from a single surface.

## Conversion & proof

- Primary CTA: Download for Mac, with the copyable `brew install --cask` command as its terminal-native twin. Secondary: Source on GitHub — for visitors not ready to install, the open code is the fallback.
- The line a visitor remembers after 10 seconds: "Stop switching — one window."
- Belief ladder, mirrored by the homepage section order: (1) my agent workflow is fragmented across windows; (2) CadencR puts agent, git, browser, editor, and terminal in one place; (3) it works with the agents I already use — Claude Code, Codex, Cursor, OpenCode — provider-neutral by design; (4) each surface is genuinely good (readable agent stream, per-task worktrees with reviewable commits, embedded browser QA); (5) it is free, open source, local, with opt-in diagnostics and detailed analytics and a separately disableable monthly installation counter. Then the closing download CTA.
- Proof on hand: the Apache-2.0 source on GitHub, real product screenshots and the hero screen recording captured from the app (`src/assets/`, `public/hero.*.mp4`), versioned release notes under `/news`, and the free / local / optional-telemetry answers in the FAQ. No testimonials or press yet.

## Brand Personality

Developer-native, precise, calm-confident. The site speaks like a good README, not a SaaS funnel: concrete feature claims ("per-task Git worktrees with visible, reviewable commits"), monospace micro-labels, real UI captures, keyboard-key glyphs. Dark by default and set like a premium instrument (see `DESIGN.md`, "Emerald Reserve"): near-monochrome ruled chrome on a graphite ground, one jewel emerald used with restraint, and the app's vivid captures as the only multi-hue color on the page.

## Anti-references

Not a generic AI-startup landing page: no hype superlatives, no fabricated dashboards — every visual is a real capture of the actual app. Not a chat-product aesthetic: CadencR is an IDE-grade workspace, not an AI sidebar, and the site should never read otherwise. Never confusable with Cadence Design Systems or the common word "cadence" — the entity-disambiguation work in the FAQ and structured data exists to keep that boundary sharp.

## Design Principles

- The product is the imagery. Real screenshots and recordings of CadencR carry the visual weight; placeholders and stock art are failure states.
- One brand, site leads. As of July 2026 the landing carries the visual direction ("Emerald Reserve", validated through an in-product palette exploration and Raphael's iterative review); the desktop defaults follow its handoff tokens (Graphite Ground, Ink, Hairline, Emerald — see root `DESIGN.md`, "Brand identity") so the marketing surface and the product read as one thing. The Index Dots mark and the Figtree 800 `CADENCR` wordmark are the official logo.
- Show, don't hype. Every claim maps to a demonstrable feature; copy stays concrete and technical.
- Disambiguation-first SEO. Copy and structured data consistently spell and frame "CadencR" so the entity wins against the "cadence" collision.
- Works without JavaScript. Content is never gated on script; reveals and motion enhance an already-visible page.

## Accessibility & Inclusion

No formal WCAG target has been declared. Shipped commitments observed in the code: every animation has a `prefers-reduced-motion` fallback; decorative elements are `aria-hidden` and interactive controls carry `aria-label`s; scroll reveals degrade to fully-visible content without JavaScript; `color-scheme: dark` is declared so form controls match the theme.

## Documentation maintenance

The 24 user guides were reviewed against v0.13.0 on 2026-10-13. Each page records
its reviewed version/date, includes at least one current UI screenshot, and links
to related workflows. The navigation registry also drives the documentation index.

![Current workspace with example conversation data](./src/assets/docs/v0.13.0/concept.png)

- Capture the running product; label synthetic conversations, schedules, and usage.
- Keep full-size captures available from the responsive image links.
- Cover providers, sidebar, schedules, branching, usage, themes, and remote access
  as durable guides rather than requiring readers to reconstruct release notes.
- Describe local code-backed ACP creation/import accurately. Public marketplace
  browsing, installation, and publication remain inactive in v0.13.0.
- Review screenshots and links on both desktop and mobile after release updates.
