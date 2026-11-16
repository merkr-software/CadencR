/**
 * Single source of truth for the homepage FAQ. The visible `<FAQ>` section and
 * the FAQPage JSON-LD both render from this array, so the schema text always
 * matches what users see (a Google requirement) and the entity-defining copy
 * lives in one place.
 *
 * The questions are deliberately disambiguation-first: they teach search
 * engines that "CadencR" is a developer tool, not a misspelling of "cadence".
 */

import { LINUX_AVAILABLE } from "@/lib/downloads";

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
    a: LINUX_AVAILABLE
      ? "CadencR ships for macOS on Apple Silicon and Intel, plus an alpha for Linux x86-64 as AppImage, DEB, and RPM packages. Native Linux ARM64 and Windows builds are planned next."
      : "CadencR ships for macOS on Apple Silicon and Intel. Linux x86-64 packages (AppImage, DEB, RPM) are coming as an alpha, and Windows is planned.",
  },
  {
    q: "Does CadencR collect telemetry?",
    a: "CadencR runs locally. Diagnostics and detailed usage analytics start off; you choose whether to enable them during onboarding or after upgrading. A separate monthly installation counter starts on when configured, even before that decision, and sends one minimal event to PostHog without a persistent identifier. Declining detailed telemetry leaves the counter setting unchanged. The counter has its own off switch in Settings, alongside the two detailed telemetry controls. No prompts, your code, conversation content, session replay, or log dumps are sent.",
  },
];
