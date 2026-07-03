import rss from "@astrojs/rss";
import { getCollection, type CollectionEntry } from "astro:content";
import type { APIContext } from "astro";

type NewsEntry = CollectionEntry<"news">;

export async function GET(context: APIContext): Promise<Response> {
  const entries: NewsEntry[] = (await getCollection("news")).sort(
    (a: NewsEntry, b: NewsEntry) => b.data.date.valueOf() - a.data.date.valueOf(),
  );

  const site = context.site ?? new URL("https://cadencr.com/");

  return rss({
    title: "CadencR news",
    description: "Release notes, articles and announcements for CadencR.",
    site,
    items: entries.map((entry) => ({
      title: entry.data.title,
      pubDate: entry.data.date,
      description: entry.data.summary,
      author: entry.data.author,
      categories: entry.data.tags,
      link: `/news/${entry.id}/`,
    })),
    customData: "<language>en-us</language>",
  });
}
