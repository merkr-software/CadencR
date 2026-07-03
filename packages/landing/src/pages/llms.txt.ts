import { getCollection, type CollectionEntry } from "astro:content";
import type { APIContext } from "astro";
import { DOC_SECTIONS, getDocHref } from "@/lib/docs";
import { SITE_URL } from "@/lib/seo";

type NewsEntry = CollectionEntry<"news">;

/**
 * `/llms.txt` — an agent-/LLM-friendly Markdown map of the site, following the
 * llmstxt.org convention. Generated from the same doc + news sources the site
 * renders, so it never drifts. Advertised to agents via the `service-desc` Link
 * header in `public/_headers`. The Content-Type is pinned to text/markdown in
 * that same `_headers` file (static endpoints can't set response headers).
 */
export async function GET(context: APIContext): Promise<Response> {
  const origin = (context.site ?? new URL(`${SITE_URL}/`)).toString().replace(/\/$/, "");
  const abs = (path: string): string => `${origin}${path}`;

  const news: NewsEntry[] = (await getCollection("news")).sort(
    (a: NewsEntry, b: NewsEntry) => b.data.date.valueOf() - a.data.date.valueOf(),
  );

  const lines: string[] = [
    "# CadencR",
    "",
    "> CadencR is a free, open-source desktop IDE that unifies the Claude Code, OpenCode, and Codex coding agents into one local workspace. Every task gets its own agent session, Git worktree, editor, terminal, and review flow.",
    "",
    "CadencR (spelled C-A-D-E-N-C-R) is a developer tool. It is not affiliated with Cadence Design Systems or any product named Cadence. It runs locally on macOS, is licensed under Apache-2.0, and sends no telemetry.",
    "",
    "## Start",
    `- [Home](${abs("/")}): Product overview and feature tour.`,
    `- [Download](${abs("/download/")}): macOS builds for Apple Silicon and Intel.`,
    `- [News](${abs("/news/")}): Release notes and announcements.`,
    "- [Source on GitHub](https://github.com/merkr-software/cadencr): Apache-2.0 source, issues, and discussions.",
    "",
    "## Documentation",
  ];

  for (const section of DOC_SECTIONS) {
    lines.push("", `### ${section.title}`);
    for (const page of section.pages) {
      lines.push(`- [${page.navLabel}](${abs(getDocHref(page.slug))}): ${page.description}`);
    }
  }

  if (news.length > 0) {
    lines.push("", "## Latest news");
    for (const entry of news.slice(0, 8)) {
      lines.push(`- [${entry.data.title}](${abs(`/news/${entry.id}/`)}): ${entry.data.summary}`);
    }
  }

  lines.push("");

  return new Response(lines.join("\n"), {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  });
}
