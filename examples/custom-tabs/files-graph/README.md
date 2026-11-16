# Files graph

A Cadencr custom tab that draws the files a feature changed as a treemap:
each directory is a frame, each file a tile whose area is its changed lines
and whose tint is its git status. Click a tile (or focus it and press Enter)
to read its diff in a side panel; Esc closes it.

It shows how to:

- call the **typed API** (`@cadencr/tab-sdk/api`): `getChangedFiles` for the
  list, `getFileDiff` for one file's unified diff;
- stay live with the **`git.status` stream**: every push (and every resync)
  schedules a coalesced refetch (at most one per second during a burst); the
  subscription closes while the tab is hidden (`useVisibility` +
  `useStream(…, { enabled })`), and an unchanged list re-renders nothing;
- remember a UI choice per project with **`useStorage`** (treemap or list);
- set the **tab badge** (`client.ui.setBadge`) to the changed-file count;
- look native with **`@cadencr/tab-kit`**: kit components (`Button`, `Tabs`,
  `Select`, `EmptyState`, `Skeleton`), `lucide-react` icons, Tailwind token
  utilities (`text-numstat-add-fg`, `bg-diff-del-bg`, …), and raw theme tokens
  (`--cadencr-chart-4`, `--cadencr-acc-green`, …) for the data colors, so the
  graph follows every Cadencr theme, light or dark.

It asks for one permission, `git:read`. The feature, branch and base branch
come from the tab context, which needs no scope.

## Reading the graph

| Glyph | Status     | Encoding                         |
| ----- | ---------- | -------------------------------- |
| A     | Added      | `--cadencr-acc-green`            |
| M     | Modified   | `--cadencr-chart-4`              |
| D     | Deleted    | `--cadencr-acc-red`, hatched     |
| U     | Untracked  | `--cadencr-chart-5`, dashed edge |
| R     | Renamed    | `--cadencr-acc-purple`           |
| !     | Conflicted | `--cadencr-acc-orange`           |

Every tile carries its glyph, so status never depends on color alone; the
thin bar along a tile's bottom splits its lines into additions and deletions.
The list view (toolbar toggle) shows the same data as rows with proportional
bars. **Uncommitted** compares the worktree with its last commit; **vs
&lt;base&gt;** shows everything the branch adds over its base branch.

## Build and install

```sh
npm run vendor         # copies the SDK/kit tarballs and the agent docs (checkout only)
npm install
npm run build          # tsc --noEmit && vite build → dist/
```

Then copy the folder (with `dist/` and `vendor/`, without `node_modules/`) to
`~/.cadencr/plugins/tabs/files-graph/` — the folder name must equal the
manifest `id` — and follow [the examples README](../README.md#install-it-in-cadencr)
to approve, enable and develop it.

## Files

| File                                    | Role                                                                    |
| --------------------------------------- | ----------------------------------------------------------------------- |
| `src/useChangedFiles.ts`                | Typed API call, `git.status` subscription, coalescing, unchanged-skip   |
| `src/useFileDiff.ts`, `src/diff.ts`     | One file's diff (refetched only when that file changes), diff parser    |
| `src/model.ts`, `src/kind.tsx`          | Status classification, grouping, totals, color table, swatch and counts |
| `src/squarify.ts`                       | Squarified treemap layout (no chart library)                            |
| `src/Treemap.tsx`, `src/FileList.tsx`   | The two views (memoized: hovering re-renders only the tooltip)          |
| `src/Header.tsx`, `src/FileTooltip.tsx` | Toolbar (scope select, view tabs), hover card                           |
| `src/DiffPanel.tsx`, `src/states.tsx`   | Diff panel (capped at 2,000 lines), loading / empty / error states      |
