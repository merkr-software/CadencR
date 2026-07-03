import { defineCollection, z } from "astro:content";
import { glob } from "astro/loaders";

const news = defineCollection({
  loader: glob({ base: "./src/content/news", pattern: "**/*.{md,mdx}" }),
  schema: z.object({
    title: z.string(),
    date: z.date(),
    summary: z.string(),
    author: z.string().default("CadencR"),
    tags: z.array(z.string()).default([]),
  }),
});

export const collections = { news };
