/**
 * Playwright's global setup runs after the web servers are up, so it also catches a reused vite or server that answers as the live chat.
 */
import type { FullConfig } from "@playwright/test";
import { servedRefusal } from "./live-guard.ts";

export default async function globalSetup(config: FullConfig): Promise<void> {
  const urls = new Set([process.env.CHAT_SERVER_URL ?? "http://127.0.0.1:5186", ...config.projects.map(p => String(p.use.baseURL ?? "")).filter(Boolean)]);
  for (const url of urls) {
    const refusal = await servedRefusal(url);
    if (refusal) throw new Error(`Refusing to run the specs: ${refusal}`);
  }
}
