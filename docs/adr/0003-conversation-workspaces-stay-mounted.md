# Conversation workspaces stay mounted in a small pool

Opening a conversation shows a workspace that is already mounted whenever it
can, instead of unmounting the previous one and mounting a new one. The
`ws-session` route keeps the most recently shown workspaces alive
(`WorkspacePool`); the visible one is laid out normally and the others are
hidden with CSS, moved out of the viewport, inert, and told they are hidden
through a per-workspace activity store. A workspace shown for the first time
mounts next to the previous one, from data fetched ahead of the click, and
paints its last messages in the commit that mounts it.

## Consequences

- A workspace's descendants run while it is hidden. Shortcuts, command-palette
  actions and anything that reaches outside its DOM (native views, global
  listeners, relayed browser shortcuts, the file watcher and other backend
  subscriptions, polls, navigation) must check `useWorkspaceActivity()`. Event
  handlers read `isActive()` when their event fires; lifecycles that run only
  while the workspace is shown use `whileActive()`; slow consumers such as a
  poll's interval read `useSettledWorkspaceActive()`, which follows in a
  transition; `useWorkspaceActive()` re-renders in the switch's own commit and
  is kept for what must not lag it (a native guest view). Viewport observers
  (`useInViewport`) keep their last state while the workspace is hidden off
  screen. A hidden workspace reads its session at a low sampling rate, one
  sampler per session however many consumers read it, so an agent streaming in
  it does not cost a render per delta.
- Showing or hiding a workspace re-renders nothing inside it in the commit that
  switches; slow consumers (`useSettledWorkspaceActive`) follow in a
  transition. The tab a navigation asks for is a request, not part of the
  workspace's identity: the workspace reads it when it mounts, and the pool
  applies it through the layout store on every later activation. Showing a
  workspace again gives focus back to the tab it shows (prompt, terminal or
  editor).
- Switching conversation re-renders the page with new route params; nothing may
  rely on a remount to reset per-conversation state above the pool. Inside a
  workspace the old guarantee holds: one instance per conversation. Navigations
  from a conversation go straight to `/ws-session/$sessionId` when the
  project's path and the feature are in the query cache: the legacy feature
  route unmounts the page, and every pooled workspace with it.
- The pool holds five shown workspaces; the least recently shown ones beyond
  that are unmounted at idle time, never during a switch. A plain primary mouse
  press on a sidebar row mounts that row's workspace hidden (a transition, with
  its preloaded snapshot hydrated first) so the click only shows it. That
  prewarmed workspace is not ranked until it is shown, is never trimmed, evicts
  nobody, and is dropped after about two seconds without a click, at the next
  idle period. Touch and pen presses only preload.
- The conversation's first page and layout are preloaded on intent (hover and
  keyboard focus after a short per-row dwell that leaving the row cancels, a
  press) and, at idle time only, for the visible sidebar rows (in the viewport
  and not inert, at most thirty per pass, skipping conversations whose agent is
  working and refreshing once those that just stopped). They are moved into the
  stores before the workspace mounts. A snapshot is older than the live session
  by construction, so a workspace opened from one runs a single incremental
  catch-up once its socket is bound.
- Side panels mount after the conversation has painted, one per frame, and only
  while the workspace is on screen; a focused side tab opens at once. Custom
  (plugin) tabs open and close with them, all at once. A workspace hidden for
  thirty seconds closes them again at idle time (editors, language servers,
  terminals, diffs, plugin guests and their queries stop), keeping the
  transcript and composer; shown later, they open again like a first open. The
  close is skipped, and tried again a grace period later, while the editor
  holds unsaved work (a dirty tab, an open untitled buffer). There is no timer
  protecting the agent pane.
- The transcript list cannot render its tail in the commit that mounts it
  (Virtuoso opens on an empty list, measures, then waits four frames). A plain
  preview of the last rows stands in for it until it has caught up.

## Considered options

React's `<Activity>` gives hidden trees the right semantics for free (no
effects, deferred updates) but hides with `display: none`: revealing re-ran
every effect, re-attached the portaled tab bodies and laid the workspace out
from scratch, which measured no faster than half a remount. Keeping one
workspace and swapping its conversation was rejected for the opposite reason:
every piece of per-conversation state in the tree would have had to be reset by
hand. Making the cold mount alone fast enough was not possible either: the
round trip for the history and the list's own opening frames both sit between
the click and the first message.
