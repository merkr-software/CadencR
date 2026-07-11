Search for existing code before writing new. Check the likely homes first:
- UI primitives: `packages/desktop/src/components/ui/` (shadcn) — don't hand-roll a button, dialog, dropdown, input, etc.
- Feature components, hooks, and helpers: `packages/desktop/src/components/`, `hooks/`, `lib/`, `stores/`.
- Backend shared logic: `packages/service/src/shared/` (git_cli, worktree_paths, slug, db, env).

Grep/glob for a similar utility, helper, hook, or component before adding one. Duplicate code is a bug — extract shared logic instead of copying.
