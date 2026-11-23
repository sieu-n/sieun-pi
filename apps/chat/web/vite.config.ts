import { fileURLToPath } from "node:url";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

const chatServer = process.env.CHAT_SERVER_URL ?? "http://127.0.0.1:5184";

export default defineConfig({
  plugins: [svelte()],
  resolve: {
    alias: {
      $lib: fileURLToPath(new URL("./src/lib", import.meta.url)),
      $pages: fileURLToPath(new URL("./src/pages", import.meta.url)),
    },
  },
  optimizeDeps: {
    include: ["marked", "dompurify", "mermaid"],
  },
  server: {
    // The specs' dev server watches no file, so another session's save under web/ reloads no page mid-run (playwright.config.ts).
    watch: process.env.CHAT_WEB_NO_WATCH === "1" ? null : undefined,
    proxy: {
      "/api": { target: chatServer, changeOrigin: true, ws: true },
      "/wiki": { target: chatServer, changeOrigin: true },
    },
  },
  preview: {
    proxy: {
      "/api": { target: chatServer, changeOrigin: true, ws: true },
      "/wiki": { target: chatServer, changeOrigin: true },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
    chunkSizeWarningLimit: 4000,
  },
});
