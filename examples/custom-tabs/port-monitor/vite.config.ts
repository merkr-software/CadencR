import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Cadencr loads dist/index.html from cadencr-tab://port-monitor/, so every URL
// in the build must be relative. `npm run dev` rebuilds on save; Cadencr
// reloads the tab whenever dist/ changes.
export default defineConfig({
  base: "./",
  plugins: [react(), tailwindcss()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
