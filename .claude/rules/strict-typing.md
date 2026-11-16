---
paths:
  - "**/*.ts"
  - "**/*.tsx"
---

Never use `any` — use `unknown` and narrow with type guards, and validate external boundaries with Zod. (`typescript/no-explicit-any` is a hard oxlint error, so this fails the build, not just review.)

Exception: `packages/tab-sdk` has no runtime dependencies by design (it ships inside every custom tab's bundle and is published to npm), so it validates the host's `MessagePort` messages with hand-written guards in `src/protocol.ts` instead of Zod. The host side of that boundary (`packages/desktop`) still validates every guest request with Zod.
