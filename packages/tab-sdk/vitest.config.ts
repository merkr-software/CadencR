import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // `.test.ts` run in Node (MessageChannel is global there); `.test.tsx`
    // need a DOM for React and theme application.
    projects: [
      {
        extends: true,
        test: { name: "node", environment: "node", include: ["src/**/*.test.ts"] },
      },
      {
        extends: true,
        test: { name: "dom", environment: "happy-dom", include: ["src/**/*.test.tsx"] },
      },
    ],
  },
});
