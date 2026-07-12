---
paths:
  - "**/*.ts"
  - "**/*.tsx"
---

Never use `any` — use `unknown` and narrow with type guards; prefer explicit types and Zod schemas at boundaries.
(enforced by oxlint `typescript/no-explicit-any` — see .oxlintrc.json.)
