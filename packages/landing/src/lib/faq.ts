/**
 * Single source of truth for the homepage FAQ. The visible `<FAQ>` section and
 * the FAQPage JSON-LD both render from this array, so the schema text always
 * matches what users see (a Google requirement) and the entity-defining copy
 * lives in one place.
 *
 * The questions are deliberately disambiguation-first: they teach search
 * engines that "CadencR" is a developer tool, not a misspelling of "cadence".
 */

interface FaqItem {
  q: string;
  a: string;
}

export const FAQ_ITEMS: FaqItem[] = [
  {
    q: "What is CadencR?",
    a: "CadencR is a free, open-source desktop IDE that unifies AI coding agents — Claude Code, OpenCode, and Codex — into one local workspace. Every task gets its own agent session, Git worktree, editor, terminal, and review flow, so you can read, steer, and ship without alt-tabbing between windows.",
  },
  {
    q: "Is CadencR the same thing as Cadence?",
    a: "No. CadencR — spelled C-A-D-E-N-C-R — is a desktop IDE for AI coding agents. It is not affiliated with Cadence Design Systems, the word cadence, or any other product named Cadence.",
  },
  {
    q: "Which coding agents does CadencR support?",
    a: "CadencR works with Claude Code, OpenCode, and Codex. It is provider-neutral by design, so each agent is surfaced through the same shared workflows instead of hardcoded, provider-specific assumptions.",
  },
  {
    q: "Is CadencR free and open source?",
    a: "Yes. CadencR is free and open source under the Apache-2.0 license. You can read the source on GitHub, build it yourself, and bring your own Claude, OpenCode, or Codex credentials.",
  },
  {
    q: "What platforms does CadencR run on?",
    a: "CadencR currently ships a desktop build for macOS on both Apple Silicon and Intel. Native Linux and Windows builds are planned next.",
  },
  {
    q: "Does CadencR collect telemetry?",
    a: "No. CadencR runs locally on your machine and sends no telemetry.",
  },
];
