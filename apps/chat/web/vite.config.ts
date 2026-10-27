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
    proxy: {
      "/api": { target: chatServer, changeOrigin: true, ws: true },
    },
  },
  preview: {
    proxy: {
      "/api": { target: chatServer, changeOrigin: true, ws: true },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
    chunkSizeWarningLimit: 4000,
  },
});
