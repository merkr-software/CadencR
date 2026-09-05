---
name: keyboard-shortcuts
description: >
  Use whenever adding, modifying, renaming, or fixing a keyboard shortcut in
  the Cadencr desktop frontend. Trigger on phrases like "add a shortcut",
  "bind a hotkey", "rebind", "remap", "shortcut doesn't work", "Cmd+X /
  Ctrl+X / hotkey fires the wrong thing", or any change touching
  packages/desktop/src/hooks/useShortcut.ts, useGlobalShortcut.ts, or
  packages/desktop/src/lib/shortcuts/. Especially trigger when a shortcut
  misfires on AZERTY, QWERTZ, Dvorak, Colemak, or any non-QWERTY layout.
user-invocable: true
---

# Keyboard shortcuts

Every customizable hotkey in the Cadencr desktop frontend flows through one
registry-backed pipeline. The rules below keep `e.code` vs `e.key` honest for
non-QWERTY users and make sure every new binding shows up in the help modal
and is rebindable.

## Architecture map

```
registry.ts          → catalog (ids, default keys, scopes, descriptions)
   │
   ▼
resolve.ts           → tokens → engine string ("mod"→"meta"/"ctrl" per platform)
   │
   ▼
overrides.ts         → Zustand store of user-customized bindings
   │
   ▼
useShortcut.ts       → id-based hooks (the only way feature code should bind)
   │
   ├─► react-hotkeys-hook       (form-aware path, already layout-aware via e.key)
   └─► useGlobalShortcut.ts     (capture-phase path, has its own matchesShortcut)
```

| File | What it owns |
|---|---|
| `packages/desktop/src/lib/shortcuts/registry.ts` | The `SHORTCUTS` array — single source of truth. Feeds the in-app ⌘/ help modal. |
| `packages/desktop/src/lib/shortcuts/resolve.ts` | `tokensToHotkeyString`, `resolveHotkeyTrigger`, `getRegistryShortcut`. Platform-aware `"mod"` translation. |
| `packages/desktop/src/lib/shortcuts/overrides.ts` | User-customized bindings (Zustand). |
| `packages/desktop/src/hooks/useShortcut.ts` | The four id-based hooks every feature should call. |
| `packages/desktop/src/hooks/useGlobalShortcut.ts` | Custom capture-phase matcher. Contains `matchesShortcut` and the `codeByKey` alias map. |
| `packages/desktop/src/hooks/useScopedHotkeys.ts` | Tab-focus-gated wrappers. |

## Rules

### 1. Register in `SHORTCUTS` before binding

Every customizable shortcut **must** have an entry in
`packages/desktop/src/lib/shortcuts/registry.ts`. Components then bind by
`id`, never by literal combo string. If a shortcut is missing from the
registry, it is undocumented (the ⌘/ help modal won't show it) and not
user-customizable.

### 2. Bind through the id-based hooks

Pick one of the four in `useShortcut.ts`:

| Hook | When to use |
|---|---|
| `useShortcut(id, cb, opts?)` | Default. Form-aware via `react-hotkeys-hook`. |
| `useScopedShortcut(id, cb, scope, opts?)` | Form-aware + gated on which feature-workspace tab has focus. |
| `useGlobalShortcutById(id, cb, opts?)` | Capture-phase — fires before CodeMirror / the terminal (celeritty) swallow the event. |
| `useScopedGlobalShortcutById(id, cb, scope, opts?)` | Capture-phase + tab-focus gate. |

Do **not** call `useGlobalShortcut(rawString, …)` directly from a feature
file. The raw hooks exist for non-customizable bindings only (digit grids,
vim chords, bare-escape dismissals).

### 3. Use `"mod"` for the platform-correct meta/ctrl

In registry entries write `keys: ["mod", "k"]`. `resolve.ts` turns that into
`meta` on macOS and `ctrl` elsewhere. Never hardcode `"meta"` or `"ctrl"` in
the registry.

### 4. Letters: prefer `e.key`, fall back to `e.code` only when mangled

This is the rule the GitHub issue #2 bug violated. In `matchesShortcut`:

```ts
// CORRECT — layout-aware with a Ctrl+letter fallback
if (/^[a-z]$/.test(parsed.key)) {
  if (/^[a-zA-Z]$/.test(e.key)) {
    return e.key.toLowerCase() === parsed.key;
  }
  // Ctrl+J → e.key is "\n" (control char), e.code stays "KeyJ".
  return e.code === `Key${parsed.key.toUpperCase()}`;
}
```

```ts
// WRONG — physical-position match, breaks every letter shortcut on AZERTY/QWERTZ
if (/^[a-z]$/.test(parsed.key)) {
  return e.code === `Key${parsed.key.toUpperCase()}`;
}
```

`e.code` reports the QWERTY-physical key. On AZERTY the labelled "A" key
sits where Q is on QWERTY, so `e.code === "KeyQ"` while `e.key === "a"`.

### 5. Shift-mangled punctuation and arrows: stay on `e.code`

When Shift is held, `e.key` morphs: `]` → `}`, `[` → `{`, `/` → `?`. Layout
also affects these. The codebase routes them through the `codeByKey` alias
table in `useGlobalShortcut.ts`:

```ts
const codeByKey: Record<string, string> = {
  "[": "BracketLeft",
  "]": "BracketRight",
  left: "ArrowLeft",
  // …
};
```

If you add a new Shift-modified punctuation shortcut, extend this table
rather than reaching for `e.key`.

### 6. No raw `e.code === "Key…"` outside `matchesShortcut`

Feature code must never reach into `KeyboardEvent.code` to match a letter.
There is exactly one canonical match point — keep it that way. Audit:

```bash
grep -rn "e\.code === ['\"]Key" packages/desktop/src
```

Expected result: a single hit, the fallback branch inside `matchesShortcut`.

## Adding a new shortcut — checklist

1. **Register** in `SHORTCUTS` (`registry.ts`):
   ```ts
   { id: "my-action", keys: ["mod", "shift", "k"], description: "Do the thing", scope: "global" },
   ```
2. **Bind** from the feature via the matching id-based hook:
   ```ts
   useShortcut("my-action", () => doTheThing(), { preventDefault: true });
   ```
3. **Test** in `useGlobalShortcut.test.ts` (or the relevant test file) — cover
   *both* a QWERTY firing and a non-QWERTY firing where `e.code` differs
   from `e.key`. The `fireKey` helper accepts `key` and `code` separately
   for exactly this reason.
4. **Run**:
   ```bash
   pnpm --filter @cadencr/desktop test -- useGlobalShortcut --run
   pnpm --filter @cadencr/desktop ts-check
   pnpm lint
   ```
5. **Audit** that you didn't sneak in a raw `e.code` letter check:
   ```bash
   grep -rn "e\.code === ['\"]Key" packages/desktop/src
   ```

## Debugging "shortcut fires the wrong action"

1. Ask: what OS keyboard layout is the user on? (AZERTY, QWERTZ, Dvorak,
   Colemak all permute QWERTY letter positions.)
2. In the browser devtools console, with the offending shortcut pressed,
   check `e.key` vs `e.code`. If they disagree on a letter and `matchesShortcut`
   uses `e.code`, that's the bug.
3. Confirm the registry entry uses `"mod"`, not `"meta"`/`"ctrl"`.
4. Confirm the feature binds via an id-based hook (search for the id in
   `packages/desktop/src/`).
5. If the shortcut is Shift+punctuation, check it's listed in `codeByKey`.

